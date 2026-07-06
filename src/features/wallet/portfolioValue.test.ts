import { describe, it, expect } from 'vitest';
import { priceKeyFor, assetUsdValue, assetPriceFor, portfolioValue } from '@/features/wallet/portfolioValue';
import type { AssetBalance } from '@/features/wallet/assetTypes';
import type { PriceMap } from '@/features/wallet/priceTypes';
import { assetDescriptors } from '@/lib/wallet-assets';
import { DIG_ASSET_ID } from '@/lib/links';

const [xchD, digD] = assetDescriptors([]);

/** Build an AssetBalance row for a descriptor with a base-unit balance. */
function row(descriptor: (typeof xchD), balance: number | null): AssetBalance {
  return { descriptor, balance, label: balance == null ? '—' : String(balance) };
}

const PRICES: PriceMap = {
  xch: { usd: 10, change24h: -5 }, // XCH at $10, down 5% (so 24h ago it was ~$10.526)
  [DIG_ASSET_ID.toLowerCase()]: { usd: 0.5, change24h: null },
};

describe('priceKeyFor', () => {
  it('keys XCH as "xch" and a CAT by its normalized asset id', () => {
    expect(priceKeyFor(xchD)).toBe('xch');
    expect(priceKeyFor(digD)).toBe(DIG_ASSET_ID.toLowerCase());
  });
});

describe('assetUsdValue', () => {
  it('converts base units → whole units × price', () => {
    // 2.5 XCH = 2_500_000_000_000 mojos × $10 = $25.
    expect(assetUsdValue(row(xchD, 2_500_000_000_000), PRICES)).toBe(25);
    // 4.000 $DIG = 4000 base units × $0.5 = $2.
    expect(assetUsdValue(row(digD, 4000), PRICES)).toBe(2);
  });

  it('returns null when the balance or the price is unavailable', () => {
    expect(assetUsdValue(row(xchD, null), PRICES)).toBeNull();
    expect(assetUsdValue(row(xchD, 1e12), {})).toBeNull();
  });
});

describe('assetPriceFor', () => {
  it('resolves a row to its AssetPrice, or undefined when unpriced', () => {
    expect(assetPriceFor(xchD, PRICES)?.usd).toBe(10);
    expect(assetPriceFor(digD, {})).toBeUndefined();
  });
});

describe('portfolioValue', () => {
  it('sums USD across priced assets and computes the weighted 24h delta', () => {
    const rows = [row(xchD, 2_000_000_000_000), row(digD, 10_000)]; // 2 XCH = $20; 10 $DIG = $5
    const pv = portfolioValue(rows, PRICES);
    expect(pv.totalUsd).toBe(25);
    // Only XCH carries a change: value now $20, 24h ago $20 / 0.95 ≈ $21.0526 → delta ≈ -$1.0526.
    expect(pv.change24hUsd).toBeCloseTo(-1.0526, 3);
    expect(pv.change24hPct).toBeCloseTo(-5, 6); // delta relative to the changed subset
  });

  it('is unavailable (null total) when no asset can be priced', () => {
    const pv = portfolioValue([row(xchD, 1e12)], {});
    expect(pv.totalUsd).toBeNull();
    expect(pv.change24hPct).toBeNull();
    expect(pv.change24hUsd).toBeNull();
  });

  it('reports a total but a null delta when no priced asset has a known change', () => {
    const pv = portfolioValue([row(digD, 2000)], PRICES); // only $DIG, change24h null
    expect(pv.totalUsd).toBe(1);
    expect(pv.change24hPct).toBeNull();
    expect(pv.change24hUsd).toBeNull();
  });
});
