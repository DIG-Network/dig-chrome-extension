/**
 * Resolve a DataLayer store's CHAIN-ANCHORED tip root directly from coinset.org (#228 — the hosted
 * rpc.dig.net tier does not serve `dig.getAnchoredRoot`; see `background/index.ts`'s
 * `resolveAnchoredRoot()`, which tries the local node first and falls back to this walk). Ports
 * hub.dig.net's `apps/web/lib/lineage.ts` `syncStore` algorithm (same `DataStore::from_spend`-per-
 * generation walk over `@dignetwork/chip35-dl-coin-wasm`), simplified to a single-shot resolve: no
 * melt registry / resume cache (a caller may add its own short-TTL cache around one resolve — see
 * `background/index.ts`'s `_coinsetAnchoredRootCache`).
 *
 * HARD BOUNDARY (#127/#226 anchored-root-pinning contract): the returned root is the sole trust
 * anchor for a rootless read — it MUST come from the chain, never the URN string or the serving
 * host. Every path here is FAIL-CLOSED: any missing coin record/spend, any `dataStoreFromSpend`
 * failure (an unparsable spend, e.g. a melt with no successor store), or exceeding `maxDepth`
 * resolves to `null`, never a guess. Callers MUST treat `null` as "unverifiable".
 *
 * Deliberately does NOT reuse `chain.ts`'s `ChainClient` (the chia-wallet-sdk-wasm `RpcClient`
 * adapter): its typed `Coin`/`CoinSpend` are chia-wallet-sdk-wasm CLASS instances, and feeding a
 * wasm class instance from ONE wasm module into another module's exported builder
 * (`chip35.dataStoreFromSpend`) is an unproven cross-module boundary. `LineageCoinsetClient` instead
 * deals only in plain data (`Uint8Array`/`bigint` fields), mirroring hub.dig.net's proven
 * `lib/coinset.ts` fetch client — safe to feed straight into chip35 regardless of origin.
 */

/** A Chia coin's identifying fields (plain data — never a wasm class instance). */
export interface LineageCoin {
  parentCoinInfo: Uint8Array;
  puzzleHash: Uint8Array;
  amount: bigint;
}

/** A coin spend: the coin plus its CLVM puzzle reveal + solution (plain data). */
export interface LineageCoinSpend {
  coin: LineageCoin;
  puzzleReveal: Uint8Array;
  solution: Uint8Array;
}

/** The subset of a chip35 wasm `DataStore` this walk reads: its own coin (to advance the lineage
 *  to the next generation), the committed metadata root, and the delegated-puzzle set the NEXT
 *  spend's parser needs (carries forward unless a spend explicitly changes it). */
export interface LineageDataStore {
  coin: LineageCoin;
  metadata: { rootHash: Uint8Array };
  delegatedPuzzles?: unknown[];
}

/** The `@dignetwork/chip35-dl-coin-wasm` surface the offscreen document uses: the chain-anchored-root
 *  walk (`dataStoreFromSpend`) plus the pure capped coin selector (#417 — `selectCoins`, used on the
 *  send path so a fragmented wallet fails recoverably; see `coinSelect.ts`). */
export interface Chip35Wasm {
  dataStoreFromSpend(coinSpend: LineageCoinSpend, prevDelegatedPuzzles: unknown[]): LineageDataStore;
  /** Optional so the anchored-root walk's test fakes (which never select coins) need not stub it;
   *  the real chip35 module always exports it, so the send path finds it at runtime. */
  selectCoins?: import('@/offscreen/coinSelect').SelectCoinsFn;
}

/** The coinset chain-read surface the walk needs (see the module doc for why this is its own,
 *  plain-data interface rather than `chain.ts`'s wasm-backed `ChainClient`). */
export interface LineageCoinsetClient {
  /** Spent status + the height it was spent at (needed to fetch its spend), or `null` when coinset
   *  can't resolve the coin (unknown / transport error — the walk fails closed on either). */
  getCoinRecord(coinIdHex: string): Promise<{ spent: boolean; spentHeight: number } | null>;
  /** The coin spend (puzzle reveal + solution) that spent `coinIdHex` at `height`, or `null`. */
  getCoinSpend(coinIdHex: string, height: number): Promise<LineageCoinSpend | null>;
}

/** Generations to follow before bailing (fail-safe — mirrors hub.dig.net's `lineage.ts` MAX_DEPTH). */
const MAX_DEPTH = 512;

function bytesToHex(u8: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += u8[i].toString(16).padStart(2, '0');
  return s;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/i, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// CLVM minimal big-endian encoding of a non-negative coin amount (a leading 0x00 when the high bit
// is set) — the same rule hub.dig.net's `spend-convert.ts` coinId() uses.
function clvmEncodeAmount(n: bigint): Uint8Array {
  if (n === 0n) return new Uint8Array(0);
  const bytes: number[] = [];
  let v = n;
  while (v > 0n) {
    bytes.unshift(Number(v & 0xffn));
    v >>= 8n;
  }
  if (bytes[0] & 0x80) bytes.unshift(0x00);
  return new Uint8Array(bytes);
}

/** Chia coin id = SHA-256(parent_coin_info ++ puzzle_hash ++ clvm_int(amount)), lowercase hex. */
export async function lineageCoinId(coin: LineageCoin): Promise<string> {
  const amt = clvmEncodeAmount(coin.amount);
  const buf = new Uint8Array(coin.parentCoinInfo.length + coin.puzzleHash.length + amt.length);
  buf.set(coin.parentCoinInfo, 0);
  buf.set(coin.puzzleHash, coin.parentCoinInfo.length);
  buf.set(amt, coin.parentCoinInfo.length + coin.puzzleHash.length);
  const digest = await crypto.subtle.digest('SHA-256', buf as BufferSource);
  return bytesToHex(new Uint8Array(digest));
}

/**
 * Walk a DataLayer store singleton's on-chain lineage from its launcher (`launcherIdHex` == the
 * store id) to the live, unspent tip, and return the tip's committed content root — the store's
 * CHAIN-ANCHORED root. See the module doc for the fail-closed contract; NEVER throws.
 */
export async function walkAnchoredRoot(
  client: LineageCoinsetClient,
  chip35: Chip35Wasm,
  launcherIdHex: string,
  maxDepth: number = MAX_DEPTH,
): Promise<string | null> {
  try {
    const launcherId = launcherIdHex.replace(/^0x/i, '').toLowerCase();
    const launcherRec = await client.getCoinRecord(launcherId);
    if (!launcherRec || !launcherRec.spent) return null; // not on chain yet / not minted

    const launcherSpend = await client.getCoinSpend(launcherId, launcherRec.spentHeight);
    if (!launcherSpend) return null;

    let cur = chip35.dataStoreFromSpend(launcherSpend, []);
    let prevDelegated: unknown[] = cur.delegatedPuzzles ?? [];

    for (let depth = 0; depth < maxDepth; depth++) {
      const curId = await lineageCoinId(cur.coin);
      const rec = await client.getCoinRecord(curId);
      if (!rec) return null; // coinset couldn't resolve this coin — never guess
      if (!rec.spent) {
        // The live, unspent tip — its committed metadata root is the chain-anchored root.
        const root = cur.metadata?.rootHash;
        return root instanceof Uint8Array && root.length === 32 ? bytesToHex(root) : null;
      }
      const spend = await client.getCoinSpend(curId, rec.spentHeight);
      if (!spend) return null;
      cur = chip35.dataStoreFromSpend(spend, prevDelegated);
      prevDelegated = cur.delegatedPuzzles ?? [];
    }
    return null; // exceeded maxDepth without reaching a live tip — fail closed, never a stale guess
  } catch {
    return null; // an unparsable spend (e.g. a melt) or any thrown error — fail closed
  }
}

/**
 * A minimal coinset JSON-RPC read client (mirrors hub.dig.net's `lib/coinset.ts`). Extensions bypass
 * CORS for hosts in `host_permissions` — `api.coinset.org` already is (#122/#226) — so this talks to
 * coinset directly, no proxy needed. Every method resolves `null` on any transport/parse error;
 * never throws (the caller, `walkAnchoredRoot`, treats `null` as fail-closed).
 */
export function makeFetchLineageClient(coinsetUrl: string, fetchImpl: typeof fetch = fetch): LineageCoinsetClient {
  return {
    async getCoinRecord(coinIdHex) {
      try {
        const res = await fetchImpl(`${coinsetUrl}/get_coin_record_by_name`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: `0x${coinIdHex}` }),
        });
        const j = await res.json().catch(() => null);
        const rec = j?.coin_record;
        if (!j?.success || !rec) return null;
        return { spent: !!rec.spent, spentHeight: Number(rec.spent_block_index || 0) };
      } catch {
        return null;
      }
    },
    async getCoinSpend(coinIdHex, height) {
      try {
        const res = await fetchImpl(`${coinsetUrl}/get_puzzle_and_solution`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ coin_id: `0x${coinIdHex}`, height }),
        });
        const j = await res.json().catch(() => null);
        const cs = j?.coin_solution;
        if (!j?.success || !cs?.coin) return null;
        return {
          coin: {
            parentCoinInfo: hexToBytes(cs.coin.parent_coin_info),
            puzzleHash: hexToBytes(cs.coin.puzzle_hash),
            amount: BigInt(cs.coin.amount),
          },
          puzzleReveal: hexToBytes(cs.puzzle_reveal),
          solution: hexToBytes(cs.solution),
        };
      } catch {
        return null;
      }
    },
  };
}
