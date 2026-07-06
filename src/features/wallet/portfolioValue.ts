/**
 * Portfolio-value selectors — pure functions that turn the wallet's `AssetBalance[]` + a `PriceMap`
 * into per-asset USD values and a total-portfolio value with a 24h delta. No DOM / chrome.* / intl,
 * so the numbers are unit-tested here and the renderer only formats + displays them.
 *
 * A value is only ever computed from a KNOWN balance AND a KNOWN price — a missing either side
 * yields null (the UI then shows the honest "value unavailable" line, never a fabricated 0).
 */

import type { AssetBalance } from './assetTypes';
import type { AssetPrice, PriceMap } from './priceTypes';
import type { AssetDescriptor } from '@/lib/wallet-assets';
import { normalizeCatId } from '@/lib/wallet-assets';

/** The `PriceMap` key for a descriptor: `'xch'` for the native coin, else its normalized TAIL. */
export function priceKeyFor(descriptor: AssetDescriptor): string | null {
  if (descriptor.key === 'xch') return 'xch';
  return normalizeCatId(descriptor.assetId);
}

/** The `AssetPrice` for a row's asset, or undefined when the map has no price for it. */
export function assetPriceFor(descriptor: AssetDescriptor, prices: PriceMap): AssetPrice | undefined {
  const key = priceKeyFor(descriptor);
  return key ? prices[key] : undefined;
}

/** USD value of one holding: `(balance / 10^decimals) × price.usd`. Null if balance/price unknown. */
export function assetUsdValue(row: AssetBalance, prices: PriceMap): number | null {
  if (row.balance == null || !Number.isFinite(row.balance)) return null;
  const price = assetPriceFor(row.descriptor, prices);
  if (!price) return null;
  return (row.balance / 10 ** row.descriptor.decimals) * price.usd;
}

/** The total-portfolio value + its 24h delta. Any field is null when it can't be honestly computed. */
export interface PortfolioValue {
  /** Sum of USD across every priced asset, or null when NO asset can be priced. */
  totalUsd: number | null;
  /** USD gained/lost over 24h across assets with a known change, or null when none has one. */
  change24hUsd: number | null;
  /** Percent change over 24h relative to that same changed subset, or null when none has one. */
  change24hPct: number | null;
}

/**
 * Aggregate per-asset USD values into a portfolio total + 24h delta. The delta is computed over the
 * subset of assets that carry a known 24h change (24h-ago value = now / (1 + change/100)); the
 * percentage is expressed relative to that subset's prior value. XCH dominates a Chia portfolio and
 * carries a change, so this is an honest, meaningful "today" figure even when some CATs lack one.
 */
export function portfolioValue(rows: AssetBalance[], prices: PriceMap): PortfolioValue {
  let total = 0;
  let priced = false;
  let subsetNow = 0;
  let subsetAgo = 0;
  let hasChange = false;

  for (const row of rows) {
    const usd = assetUsdValue(row, prices);
    if (usd == null) continue;
    priced = true;
    total += usd;
    const change = assetPriceFor(row.descriptor, prices)?.change24h;
    if (change != null && Number.isFinite(change) && 1 + change / 100 > 0) {
      hasChange = true;
      subsetNow += usd;
      subsetAgo += usd / (1 + change / 100);
    }
  }

  if (!priced) return { totalUsd: null, change24hUsd: null, change24hPct: null };
  if (!hasChange || subsetAgo <= 0) return { totalUsd: total, change24hUsd: null, change24hPct: null };
  const change24hUsd = subsetNow - subsetAgo;
  return { totalUsd: total, change24hUsd, change24hPct: (change24hUsd / subsetAgo) * 100 };
}
