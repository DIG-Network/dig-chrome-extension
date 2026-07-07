/**
 * Asset-list ordering (#167) — a pure VIEW selector over the already-resolved `AssetBalance[]` from
 * `custodyAssetBalances`. It does NOT touch the scan/derivation: given the same rows, it only
 * reorders them for display, highest value first, so the Assets list reads like a portfolio rather
 * than raw discovery order.
 *
 * XCH is the hero/prominent balance (`pickHeroBalance`) and always sorts first, unmoved. Every other
 * row — $DIG + discovered/watched CATs — sorts beneath it in two tiers:
 *   1. Rows with a KNOWN USD value (`assetUsdValue`), highest value first.
 *   2. Rows with NO known price, sorted after every priced row: a "known" token ($DIG, or a CAT
 *      whose ticker resolved via the registry — see `resolveCatMeta`) outranks a generic-unknown
 *      one, then within a tier by held amount (normalized by decimals), descending. A null/unknown
 *      balance sinks to the bottom of its tier.
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
 * A "known" token for the no-price fallback tier: $DIG (always a named, built-in row) or a CAT
 * whose ticker resolved against the registry (i.e. NOT the generic "CAT" fallback `resolveCatMeta`
 * emits for an unrecognized TAIL).
 */
function isKnownAsset(row: AssetBalance): boolean {
  return row.descriptor.key === 'dig' || row.descriptor.ticker !== 'CAT';
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
 * Order `rows` for the Assets list: XCH first (untouched), then every other row sorted by value,
 * highest first, per the tiered rule above. Pure + total — returns a NEW array with the same rows,
 * never dropping or duplicating one.
 */
export function orderAssetsByValue(rows: AssetBalance[], prices: PriceMap): AssetBalance[] {
  const xch = rows.filter((r) => r.descriptor.key === 'xch');
  const rest = rows.filter((r) => r.descriptor.key !== 'xch');

  const scored: ScoredRow[] = rest.map((row, index) => ({
    row,
    index,
    usd: assetUsdValue(row, prices),
    known: isKnownAsset(row),
    amount: normalizedAmount(row),
  }));
  scored.sort(compareScored);

  return [...xch, ...scored.map((s) => s.row)];
}
