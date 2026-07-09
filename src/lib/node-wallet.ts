/**
 * dig-node Sage-parity wallet-data CLIENT (#217, design `docs/design/dig-node-sage-parity-rpc.md`
 * Part A + D) — the READ-ONLY client the extension uses when a wallet-data source resolves to a
 * dig-node (see `wallet-source.ts`). It POSTs Sage `endpoints.json` `get_*` methods to the node's
 * browser-facing plain-HTTP + CORS mirror (`POST {base}/{method}`, snake_case, Sage v0.12.11 shapes;
 * design C.3 transport #2 / port 9778) and MAPS each response into the extension's existing
 * wallet-data result shapes so the React UI + RTK Query layer are source-agnostic.
 *
 * READS ONLY. This client never calls a spend/sign/send method — the extension SIGNS locally in the
 * offscreen DIGWX1 vault and the node never receives a key (issue #217 HARD gate). `fetch` + a
 * timeout are injected so the mappers are fully unit-tested against canned Sage responses (§2.1).
 *
 * Shape targets (the vault's own returns — proven identical in the tests):
 *  - balances → `{ xch: number; cats: Record<string, number> }`   (base units; `scan.ts` `BalanceScan`)
 *  - nfts     → `{ nfts: WalletNft[] }`                            (`@/offscreen/nfts`)
 *  - dids     → `{ dids: WalletDid[] }`                            (`@/offscreen/dids`)
 *  - coins    → `{ coins: WalletCoin[] }`                          (`{ coinId, amount, confirmedHeight }`)
 *  - activity → `{ events: LocalActivityEntry[] }`                 (`@/lib/activity-log`)
 */

import type { WalletNft } from '@/offscreen/nfts';
import type { WalletDid } from '@/offscreen/dids';
import type { LocalActivityEntry, ActivityKind } from '@/lib/activity-log';

/** One listed unspent coin — structurally the vault's `CoinInfo` / the UI's `WalletCoin`. */
export interface WalletCoin {
  coinId: string;
  amount: string;
  confirmedHeight: number;
}

/** Sage `Amount` (`types/amount.rs`): a JSON number (≤ MAX_JS_SAFE) or a string (larger). */
type SageAmount = number | string;

/** Lowercase + strip a leading `0x` so node hex matches the vault's `strip0x` convention. */
function strip0x(hex: string | null | undefined): string {
  const s = (hex ?? '').toLowerCase();
  return s.startsWith('0x') ? s.slice(2) : s;
}

/** Parse a Sage `Amount` to a JS number of base units (mojos / CAT base units). */
function amountToNumber(a: SageAmount | null | undefined): number {
  if (a == null) return 0;
  const n = typeof a === 'number' ? a : Number(a);
  return Number.isFinite(n) ? n : 0;
}

/** Parse a Sage `Amount` to a decimal base-units STRING (never `0x`, never scientific). */
function amountToDecimalString(a: SageAmount | null | undefined): string {
  if (a == null) return '0';
  if (typeof a === 'string') return a.trim() || '0';
  return Number.isFinite(a) ? BigInt(Math.trunc(a)).toString() : '0';
}

// ── Minimal Sage response shapes (only the fields the mappers read; forward-compatible/additive) ──

interface SageSyncStatus {
  selectable_balance?: SageAmount;
  synced_coins?: number;
  total_coins?: number;
}
interface SageTokenRecord {
  asset_id?: string | null;
  balance?: SageAmount;
}
interface SageNftRecord {
  launcher_id: string;
  coin_id: string;
  collection_id?: string | null;
  owner_did?: string | null;
  royalty_ten_thousandths?: number;
  royalty_address?: string | null;
  data_uris?: string[];
  data_hash?: string | null;
  metadata_uris?: string[];
  metadata_hash?: string | null;
  license_uris?: string[];
  edition_number?: number | null;
  edition_total?: number | null;
}
interface SageDidRecord {
  launcher_id: string;
  coin_id: string;
  name?: string | null;
  recovery_hash?: string | null;
}
interface SageCoinRecord {
  coin_id: string;
  amount?: SageAmount;
  created_height?: number | null;
}
interface SageAsset {
  asset_id?: string | null;
  kind?: string;
}
interface SageTransactionCoinRecord {
  coin_id: string;
  amount?: SageAmount;
  address_kind?: string;
  asset?: SageAsset;
}
interface SageTransactionRecord {
  height: number;
  timestamp?: number | null;
  spent?: SageTransactionCoinRecord[];
  created?: SageTransactionCoinRecord[];
}

/** The node wallet-data client surface (reads only). */
export interface NodeWalletClient {
  /** `get_sync_status` — the sync-gating state (design B.6/A.9 poll-for-events). */
  getSyncStatus(): Promise<{ syncedCoins: number; totalCoins: number; synced: boolean; selectableXch: number }>;
  /** Balances from `get_sync_status` (XCH selectable) + `get_cats` (per-CAT), base units. */
  getBalances(): Promise<{ xch: number; cats: Record<string, number> }>;
  /** NFTs from `get_nfts`, mapped to the vault's `WalletNft`. */
  getNfts(): Promise<{ nfts: WalletNft[] }>;
  /** DIDs from `get_dids`, mapped to the vault's `WalletDid`. */
  getDids(): Promise<{ dids: WalletDid[] }>;
  /** Unspent coins from `get_coins` (optionally one asset), mapped to `WalletCoin`. */
  getCoins(assetId?: string): Promise<{ coins: WalletCoin[] }>;
  /** Activity from `get_transactions`, mapped to confirmed `LocalActivityEntry[]` (block-time). */
  getActivity(): Promise<{ events: LocalActivityEntry[] }>;
}

/** How many rows to request for the paged list endpoints (one personal wallet fits comfortably). */
const LIST_LIMIT = 1000;

/**
 * Build a {@link NodeWalletClient} that POSTs Sage-parity methods to `base` (e.g.
 * `http://localhost:9778`). `fetch` + `timeoutMs` are injected; a non-2xx response or a transport
 * error throws (the SW then falls back to coinset in `auto` mode, or surfaces an error in a strict
 * node/custom mode — `wallet-source.ts`).
 */
export function makeNodeWalletClient(
  base: string,
  { fetch: fetchImpl = fetch, timeoutMs = 12_000 }: { fetch?: typeof fetch; timeoutMs?: number } = {},
): NodeWalletClient {
  const root = base.replace(/\/+$/, '');

  /** POST one Sage method (`POST {base}/{method}`); parse JSON on 2xx, throw the text body otherwise. */
  async function call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    try {
      const res = await fetchImpl(`${root}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
        signal: ctrl ? ctrl.signal : undefined,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`dig-node ${method} failed (${res.status})${text ? ': ' + text : ''}`);
      }
      return (await res.json()) as T;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return {
    async getSyncStatus() {
      const s = await call<SageSyncStatus>('get_sync_status');
      const syncedCoins = s.synced_coins ?? 0;
      const totalCoins = s.total_coins ?? 0;
      return {
        syncedCoins,
        totalCoins,
        synced: totalCoins > 0 ? syncedCoins >= totalCoins : true,
        selectableXch: amountToNumber(s.selectable_balance),
      };
    },

    async getBalances() {
      const [sync, catsRes] = await Promise.all([
        call<SageSyncStatus>('get_sync_status'),
        call<{ cats?: SageTokenRecord[] }>('get_cats'),
      ]);
      const cats: Record<string, number> = {};
      for (const t of catsRes.cats ?? []) {
        const id = strip0x(t.asset_id);
        if (!id) continue;
        cats[id] = amountToNumber(t.balance);
      }
      return { xch: amountToNumber(sync.selectable_balance), cats };
    },

    async getNfts() {
      const res = await call<{ nfts?: SageNftRecord[] }>('get_nfts', {
        offset: 0,
        limit: LIST_LIMIT,
        include_hidden: false,
      });
      const nfts: WalletNft[] = (res.nfts ?? []).map((n) => ({
        launcherId: strip0x(n.launcher_id),
        coinId: strip0x(n.coin_id),
        // The Sage NftRecord exposes the owning p2 only as a bech32m address (no hex); the vault's
        // hex `p2PuzzleHash` is used by the LOCAL signing/transfer path (re-derived from chain in the
        // vault), never by the node-sourced list/detail view — so it is intentionally blank here.
        p2PuzzleHash: '',
        collectionId: n.owner_did ? strip0x(n.owner_did) : n.collection_id ? strip0x(n.collection_id) : null,
        editionNumber: (n.edition_number ?? 1).toString(),
        editionTotal: (n.edition_total ?? 1).toString(),
        royaltyBasisPoints: n.royalty_ten_thousandths ?? 0,
        royaltyPuzzleHash: strip0x(n.royalty_address),
        dataUris: n.data_uris ?? [],
        dataHash: n.data_hash ? strip0x(n.data_hash) : null,
        metadataUris: n.metadata_uris ?? [],
        metadataHash: n.metadata_hash ? strip0x(n.metadata_hash) : null,
        licenseUris: n.license_uris ?? [],
      }));
      return { nfts };
    },

    async getDids() {
      const res = await call<{ dids?: SageDidRecord[] }>('get_dids');
      const dids: WalletDid[] = (res.dids ?? []).map((d) => ({
        launcherId: strip0x(d.launcher_id),
        coinId: strip0x(d.coin_id),
        // As with NFTs, the p2 hex is not in the Sage DidRecord (only a bech32m address) and is used
        // only by the local signing path; blank for the node-sourced identity list.
        p2PuzzleHash: '',
        recoveryListHash: d.recovery_hash ? strip0x(d.recovery_hash) : null,
        // Sage's DidRecord does not carry the recovery verification count; default to '1' (the DID
        // singleton default). The value is display-only in the identity list.
        numVerificationsRequired: '1',
        profileName: d.name && d.name.length > 0 ? d.name : null,
      }));
      return { dids };
    },

    async getCoins(assetId?: string) {
      const res = await call<{ coins?: SageCoinRecord[] }>('get_coins', {
        ...(assetId ? { asset_id: assetId } : {}),
        offset: 0,
        limit: LIST_LIMIT,
        sort_mode: 'amount',
        filter_mode: 'unspent',
        ascending: false,
      });
      const coins: WalletCoin[] = (res.coins ?? []).map((c) => ({
        coinId: strip0x(c.coin_id),
        amount: amountToDecimalString(c.amount),
        confirmedHeight: c.created_height ?? 0,
      }));
      return { coins };
    },

    async getActivity() {
      const res = await call<{ transactions?: SageTransactionRecord[] }>('get_transactions', {
        offset: 0,
        limit: LIST_LIMIT,
        ascending: false,
      });
      const events: LocalActivityEntry[] = [];
      for (const tx of res.transactions ?? []) events.push(...transactionToEntries(tx));
      return { events };
    },
  };
}

/**
 * The per-asset net-flow key used to classify a transaction leg: a CAT's TAIL hex when the leg
 * carries an `asset_id`, else `'XCH'` (native — Sage leaves `asset_id` null for XCH).
 */
function assetKeyOf(a: SageAsset | undefined): string {
  return a && a.asset_id ? strip0x(a.asset_id) : 'XCH';
}

/**
 * Map one Sage `TransactionRecord` to zero-or-more confirmed {@link LocalActivityEntry}: net own
 * flow per asset (created-to-own minus spent-from-own). A positive net is a `received`, a negative
 * net a `sent`; a zero net (pure self-transfer / fee-only) yields nothing. Block-time confirmed —
 * this is real chain history, unlike the extension's own optimistic local log.
 */
export function transactionToEntries(tx: SageTransactionRecord): LocalActivityEntry[] {
  const net = new Map<string, { amount: bigint; createdCoin: string | null; spentCoin: string | null }>();
  const at = (key: string) => {
    let cur = net.get(key);
    if (!cur) {
      cur = { amount: 0n, createdCoin: null, spentCoin: null };
      net.set(key, cur);
    }
    return cur;
  };
  for (const c of tx.created ?? []) {
    if (c.address_kind !== 'own') continue;
    const cur = at(assetKeyOf(c.asset));
    cur.amount += BigInt(amountToDecimalString(c.amount));
    if (cur.createdCoin == null) cur.createdCoin = strip0x(c.coin_id);
  }
  for (const c of tx.spent ?? []) {
    if (c.address_kind !== 'own') continue;
    const cur = at(assetKeyOf(c.asset));
    cur.amount -= BigInt(amountToDecimalString(c.amount));
    if (cur.spentCoin == null) cur.spentCoin = strip0x(c.coin_id);
  }
  const timestamp = (tx.timestamp ?? 0) * 1000;
  const out: LocalActivityEntry[] = [];
  for (const [key, v] of net) {
    if (v.amount === 0n) continue;
    const received = v.amount > 0n;
    const kind: ActivityKind = received ? 'received' : 'sent';
    // Representative coin id: the received own coin for a receive, the spent own coin for a send.
    const coinId = received ? v.createdCoin ?? v.spentCoin : v.spentCoin ?? v.createdCoin;
    out.push({
      id: `node:${tx.height}:${key}`,
      kind,
      asset: key,
      amount: (v.amount < 0n ? -v.amount : v.amount).toString(),
      counterparty: null,
      coinId,
      timestamp,
      status: 'confirmed',
    });
  }
  return out;
}
