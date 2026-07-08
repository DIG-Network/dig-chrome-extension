/**
 * Asset-list ordering (#167, pinned order revised by #202) — a pure VIEW selector over the
 * already-resolved `AssetBalance[]` from `custodyAssetBalances`. It does NOT touch the
 * scan/derivation: given the same rows, it only reorders them for display so the Assets list reads
 * like a portfolio rather than raw discovery order.
 *
 * The order is:
 *   1. **XCH** — the hero/prominent balance (`pickHeroBalance`), always first, unmoved.
 *   2. **$DIG** — always second, UNCONDITIONALLY (regardless of its own or any other row's USD
 *      value) — it's the network's own token, not just another CAT (#202).
 *   3. **Every other CAT**, sorted beneath those two in two tiers:
 *      a. Rows with a KNOWN USD value (`assetUsdValue`), highest value first.
 *      b. Rows with NO known price, sorted after every priced row: a CAT whose ticker resolved via
 *         the registry (see `resolveCatMeta`) outranks the generic-unknown "CAT" fallback, then
 *         within a tier by held amount (normalized by decimals), descending. A null/unknown balance
 *         sinks to the bottom of its tier.
 * Ties preserve the original (discovery) order — a stable sort.
 */

import type { AssetBalance } from '@/features/wallet/assetTypes';
import type { PriceMap } from '@/features/wallet/priceTypes';
import { assetUsdValue } from '@/features/wallet/portfolioValue';

/** Normalized held amount (balance ÷ 10^decimals), or -Infinity when unknown so it sorts last. */
function normalizedAmount(row: AssetBalance): number {
  if (row.balance == null || !Number.isFinite(row.balance)) return -Infinity;
  return row.balance / 10 ** row.descriptor.decimals;
}

/**
 * A "known" CAT for the no-price fallback tier: one whose ticker resolved against the registry
 * (i.e. NOT the generic "CAT" fallback `resolveCatMeta` emits for an unrecognized TAIL). $DIG is
 * pinned separately (see {@link orderAssetsByValue}) so it never reaches this tie-break.
 */
function isKnownAsset(row: AssetBalance): boolean {
  return row.descriptor.ticker !== 'CAT';
}

/** Sort key used to order the non-XCH rows; keeps the comparator itself simple/readable. */
interface ScoredRow {
  row: AssetBalance;
  index: number;
  usd: number | null;
  known: boolean;
  amount: number;
}

function compareScored(a: ScoredRow, b: ScoredRow): number {
  const aPriced = a.usd != null;
  const bPriced = b.usd != null;
  if (aPriced !== bPriced) return aPriced ? -1 : 1; // priced rows always outrank unpriced ones
  if (aPriced && bPriced && a.usd !== b.usd) return (b.usd as number) - (a.usd as number); // higher USD first
  if (!aPriced && a.known !== b.known) return a.known ? -1 : 1; // known before generic-unknown
  if (!aPriced && a.amount !== b.amount) return b.amount - a.amount; // bigger holding first
  return a.index - b.index; // stable tie-break (preserve discovery order)
}

/**
 * Order `rows` for the Assets list: XCH first, $DIG pinned second (both untouched by value), then
 * every remaining CAT sorted by value, highest first, per the tiered rule above (#202). Pure +
 * total — returns a NEW array with the same rows, never dropping or duplicating one.
 */
export function orderAssetsByValue(rows: AssetBalance[], prices: PriceMap): AssetBalance[] {
  const xch = rows.filter((r) => r.descriptor.key === 'xch');
  const dig = rows.filter((r) => r.descriptor.key === 'dig');
  const rest = rows.filter((r) => r.descriptor.key !== 'xch' && r.descriptor.key !== 'dig');

  const scored: ScoredRow[] = rest.map((row, index) => ({
    row,
    index,
    usd: assetUsdValue(row, prices),
    known: isKnownAsset(row),
    amount: normalizedAmount(row),
  }));
  scored.sort(compareScored);

  return [...xch, ...dig, ...scored.map((s) => s.row)];
}

/** The two protocol-native asset keys pinned above the filter (#204) — never entered into the
 * filterable set, regardless of value. */
const PINNED_KEYS = new Set(['xch', 'dig']);

/** The Assets-list split #204 needs: a fixed pinned header block, and the filterable rest. */
export interface PinnedAssetSections {
  /** XCH (if held) then $DIG (if held), in that order — ALWAYS visible, never touched by a filter
   * query. Empty when the wallet holds neither. */
  pinned: AssetBalance[];
  /** Every other CAT, value-sorted per {@link orderAssetsByValue} — the ONLY rows a filter query
   * ever narrows. */
  filterable: AssetBalance[];
}

/**
 * Split {@link orderAssetsByValue}'s output into the pinned XCH+$DIG header block and the
 * filterable CAT list beneath it (#204 — a follow-up to #202's pinned ordering). `pinned` is
 * exactly the rows the filter input must NEVER hide or reorder; the caller renders `pinned` above
 * the filter field and applies the filter predicate to `filterable` only. Pure + total (the same
 * rows as the input, just partitioned — never dropped or duplicated).
 */
export function splitPinnedAssets(rows: AssetBalance[], prices: PriceMap): PinnedAssetSections {
  const ordered = orderAssetsByValue(rows, prices);
  const pinned = ordered.filter((r) => PINNED_KEYS.has(r.descriptor.key));
  const filterable = ordered.filter((r) => !PINNED_KEYS.has(r.descriptor.key));
  return { pinned, filterable };
}
