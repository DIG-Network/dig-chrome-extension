/**
 * Self-custody activity indexer (§4.3, §165) — reconstructs a human-readable transaction ledger from
 * coinset (there is no tx-history endpoint). Runs in the offscreen vault (holds the seed + wasm).
 * Read-only: derives the HD puzzle hashes (both schemes) AT THE ACTIVE INDEX + watched-CAT puzzle
 * hashes, fetches their coin records INCLUDING spent, and:
 *   - RECEIVED: a coin created to us whose parent is NOT one of our coins (change is skipped).
 *   - SENT / TRADE: a coin of ours that was spent → decode its spend's CREATE_COINs; outputs to
 *     others = sent (recipient resolved), outputs to the settlement puzzle = a trade.
 * Amounts are pooled per coin; classification covers XCH + watched CATs + offer-settlement trades
 * (NFT/DID singletons live at other puzzle hashes and simply don't surface here — a later refinement).
 * Pure (injected wasm + chain); the SW caches the result + a height cursor for incremental scans.
 */

import { buildKeyring, type SendFlowWasm } from '@/offscreen/sendFlow';
import type { ChainClient } from '@/offscreen/chain';

/** The wasm surface the indexer needs (derivation + CAT + decode + settlement constant + address). */
export interface ActivityWasm extends Omit<SendFlowWasm, 'Address'> {
  Address: (new (puzzleHash: Uint8Array, prefix: string) => { encode(): string }) & {
    decode(address: string): { puzzleHash: Uint8Array };
  };
  Constants: { settlementPaymentHash(): Uint8Array };
}

/** One reconstructed ledger event (raw; the UI view-model turns it into a human sentence). */
export interface ActivityEvent {
  /** Stable id (kind-prefixed coin id) for React keys + dedupe. */
  id: string;
  kind: 'sent' | 'received' | 'trade';
  /** `'XCH'` or a CAT asset id (TAIL hex). */
  asset: string;
  /** Amount in base units. */
  amount: string;
  /** Recipient address for a send (best-effort), else null. */
  counterparty: string | null;
  /** Block height (created for received, spent for sent). */
  height: number;
  /** Block timestamp (seconds). */
  timestamp: number;
  /** The relevant coin id (SpaceScan + receipt). */
  coinId: string;
}

/** The indexer result: the new events (newest first) + the height to resume an incremental scan. */
export interface ActivityIndex {
  events: ActivityEvent[];
  cursorHeight: number;
}

const MAX_COST = 11_000_000_000n;
const strip0x = (h: string): string => h.replace(/^0x/i, '').toLowerCase();

export async function indexActivity(
  chia: ActivityWasm,
  chain: ChainClient,
  opts: { seed: Uint8Array; watchedCats?: string[]; activeIndex?: number; sinceHeight?: number; prefix?: string },
): Promise<ActivityIndex> {
  const sinceHeight = opts.sinceHeight ?? 0;
  const prefix = opts.prefix ?? 'xch';
  const keyring = buildKeyring(chia as unknown as SendFlowWasm, opts.seed, { index: opts.activeIndex ?? 0 });

  const xchPhs = new Set(keyring.map((k) => k.puzzleHashHex));
  const catPhToAsset = new Map<string, string>();
  for (const rawTail of opts.watchedCats ?? []) {
    const tail = strip0x(rawTail);
    const assetId = chia.fromHex(tail);
    for (const k of keyring) {
      catPhToAsset.set(strip0x(chia.toHex(chia.catPuzzleHash(assetId, chia.fromHex(k.puzzleHashHex)))), tail);
    }
  }
  const allPhs = [...xchPhs, ...catPhToAsset.keys()];
  const records = await chain.coinRecords(allPhs, { includeSpent: true, startHeight: sinceHeight });

  const ourCoinIds = new Set(records.map((r) => strip0x(chia.toHex(r.coin.coinId()))));
  const settleHex = strip0x(chia.toHex(chia.Constants.settlementPaymentHash()));
  const isOurs = (ph: string): boolean => xchPhs.has(ph) || catPhToAsset.has(ph);
  const assetOf = (ph: string): string => (xchPhs.has(ph) ? 'XCH' : (catPhToAsset.get(ph) ?? 'XCH'));

  const events: ActivityEvent[] = [];
  let cursor = sinceHeight;
  const clvm = new chia.Clvm();

  for (const r of records) {
    const phHex = strip0x(chia.toHex(r.coin.puzzleHash));
    const asset = assetOf(phHex);
    const coinIdHex = strip0x(chia.toHex(r.coin.coinId()));
    cursor = Math.max(cursor, r.confirmedHeight, r.spentHeight);

    // RECEIVED — created to us by a parent that isn't ours (our own change is skipped). A coin
    // record is a confirmed coin, so no height guard is needed (the sim reports height 0).
    if (!ourCoinIds.has(strip0x(chia.toHex(r.coin.parentCoinInfo)))) {
      events.push({ id: `r:${coinIdHex}`, kind: 'received', asset, amount: r.coin.amount.toString(), counterparty: null, height: r.confirmedHeight, timestamp: r.timestamp, coinId: coinIdHex });
    }

    // SENT / TRADE — we spent this coin; decode its outputs (the first coin carries them, §6).
    if (r.spent) {
      const spend = await chain.getCoinSpend(coinIdHex);
      if (spend) {
        const conds = clvm.deserialize(spend.puzzleReveal).run(clvm.deserialize(spend.solution), MAX_COST, false).value.toList() ?? [];
        let sentTotal = 0n;
        let recipient: string | null = null;
        let isTrade = false;
        for (const c of conds) {
          const cc = c.parseCreateCoin();
          if (!cc) continue;
          const outPh = strip0x(chia.toHex(cc.puzzleHash));
          if (outPh === settleHex) {
            isTrade = true;
            sentTotal += cc.amount;
          } else if (!isOurs(outPh)) {
            sentTotal += cc.amount;
            if (!recipient) {
              try {
                recipient = new chia.Address(cc.puzzleHash, prefix).encode();
              } catch {
                recipient = null;
              }
            }
          }
        }
        if (sentTotal > 0n) {
          events.push({ id: `s:${coinIdHex}`, kind: isTrade ? 'trade' : 'sent', asset, amount: sentTotal.toString(), counterparty: recipient, height: r.spentHeight, timestamp: r.timestamp, coinId: coinIdHex });
        }
      }
    }
  }

  events.sort((a, b) => b.height - a.height || b.timestamp - a.timestamp);
  return { events, cursorHeight: cursor };
}
