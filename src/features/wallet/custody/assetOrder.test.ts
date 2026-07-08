import { describe, it, expect } from 'vitest';
import { orderAssetsByValue, splitPinnedAssets } from '@/features/wallet/custody/assetOrder';
import type { AssetBalance } from '@/features/wallet/assetTypes';
import type { AssetDescriptor } from '@/lib/wallet-assets';
import type { PriceMap } from '@/features/wallet/priceTypes';

const CAT_A = 'a'.repeat(64); // registry-resolved ticker "AAA"
const CAT_B = 'b'.repeat(64); // registry-resolved ticker "BBB"
const CAT_U = 'c'.repeat(64); // unresolved → generic "CAT" ticker

function descriptor(over: Partial<AssetDescriptor>): AssetDescriptor {
  return { key: 'cat', ticker: 'CAT', name: 'Token', decimals: 3, assetId: null, type: 'cat', ...over };
}

function row(over: Partial<AssetDescriptor>, balance: number | null): AssetBalance {
  const d = descriptor(over);
  return { descriptor: d, balance, label: balance == null ? '—' : String(balance) };
}

const xchRow = (balance: number | null) => row({ key: 'xch', ticker: 'XCH', name: 'Chia', decimals: 12, type: null }, balance);
const digRow = (balance: number | null) => row({ key: 'dig', ticker: '$DIG', name: 'DIG', decimals: 3, assetId: 'dig-tail' }, balance);
const catRow = (assetId: string, ticker: string, balance: number | null) => row({ assetId, ticker }, balance);

describe('orderAssetsByValue', () => {
  it('always keeps XCH first, regardless of its own or others’ value', () => {
    const prices: PriceMap = { xch: { usd: 1, change24h: null }, [CAT_A]: { usd: 1000, change24h: null } };
    const ordered = orderAssetsByValue([xchRow(1), catRow(CAT_A, 'AAA', 5_000_000)], prices);
    expect(ordered[0].descriptor.key).toBe('xch');
  });

  // #202 — $DIG is ALWAYS pinned second, beneath XCH, regardless of its own or any CAT's USD value.
  it('pins $DIG second even when a CAT is worth far more', () => {
    const prices: PriceMap = {
      xch: { usd: 10, change24h: null },
      [CAT_A]: { usd: 1000, change24h: null }, // worth vastly more than $DIG
    };
    const ordered = orderAssetsByValue([xchRow(1), catRow(CAT_A, 'AAA', 5_000_000), digRow(1)], prices);
    expect(ordered.map((r) => r.descriptor.key)).toEqual(['xch', 'dig', 'cat']);
  });

  it('pins $DIG second even when $DIG itself is unpriced and other CATs ARE priced', () => {
    const prices: PriceMap = { xch: { usd: 10, change24h: null }, [CAT_A]: { usd: 5, change24h: null } };
    const ordered = orderAssetsByValue([xchRow(1), catRow(CAT_A, 'AAA', 1000), digRow(1)], prices);
    expect(ordered.map((r) => r.descriptor.ticker)).toEqual(['XCH', '$DIG', 'AAA']);
  });

  it('sorts the remaining CATs (XCH + $DIG excluded) by descending USD value', () => {
    const prices: PriceMap = {
      xch: { usd: 10, change24h: null },
      [CAT_A]: { usd: 0.1, change24h: null }, // 1000 base / 1000 = 1 unit × $0.1 = $0.10
      [CAT_B]: { usd: 5, change24h: null }, // 3000 base / 1000 = 3 units × $5 = $15
    };
    const ordered = orderAssetsByValue([xchRow(1_000_000_000_000), catRow(CAT_A, 'AAA', 1000), catRow(CAT_B, 'BBB', 3000), digRow(1)], prices);
    expect(ordered.map((r) => r.descriptor.ticker)).toEqual(['XCH', '$DIG', 'BBB', 'AAA']);
  });

  it('places every priced CAT above every unpriced CAT', () => {
    const prices: PriceMap = { xch: { usd: 10, change24h: null }, [CAT_A]: { usd: 0.01, change24h: null } };
    // CAT_B holds a much bigger raw amount but has NO known price — it must still sort beneath the
    // tiny-but-priced CAT_A.
    const ordered = orderAssetsByValue([xchRow(1), catRow(CAT_B, 'BBB', 9_000_000), catRow(CAT_A, 'AAA', 1), digRow(1)], prices);
    expect(ordered.map((r) => r.descriptor.ticker)).toEqual(['XCH', '$DIG', 'AAA', 'BBB']);
  });

  it('within unpriced CATs, a registry-resolved ticker outranks an unresolved "CAT" fallback', () => {
    const ordered = orderAssetsByValue([xchRow(1), catRow(CAT_U, 'CAT', 999_999_999), digRow(1), catRow(CAT_A, 'AAA', 1)], {});
    // AAA (registry-resolved) sorts before the unresolved CAT_U, no matter how large its amount.
    const tickers = ordered.map((r) => r.descriptor.ticker);
    expect(tickers).toEqual(['XCH', '$DIG', 'AAA', 'CAT']);
  });

  it('within the same known/unknown tier, sorts by held amount descending when unpriced', () => {
    const ordered = orderAssetsByValue([xchRow(1), catRow(CAT_A, 'AAA', 100), catRow(CAT_B, 'BBB', 5000)], {});
    expect(ordered.map((r) => r.descriptor.ticker)).toEqual(['XCH', 'BBB', 'AAA']);
  });

  it('treats a null (unknown) balance as the lowest amount within its tier', () => {
    const ordered = orderAssetsByValue([xchRow(1), catRow(CAT_A, 'AAA', null), catRow(CAT_B, 'BBB', 1)], {});
    expect(ordered.map((r) => r.descriptor.ticker)).toEqual(['XCH', 'BBB', 'AAA']);
  });

  it('is stable for ties (preserves original relative order)', () => {
    const ordered = orderAssetsByValue([xchRow(1), catRow(CAT_A, 'AAA', 100), catRow(CAT_B, 'BBB', 100)], {});
    expect(ordered.map((r) => r.descriptor.ticker)).toEqual(['XCH', 'AAA', 'BBB']);
  });

  it('is a pure reorder: same length, no row dropped or duplicated', () => {
    const rows = [xchRow(1), digRow(10), catRow(CAT_A, 'AAA', 5), catRow(CAT_U, 'CAT', 2)];
    const ordered = orderAssetsByValue(rows, {});
    expect(ordered).toHaveLength(rows.length);
    expect(new Set(ordered)).toEqual(new Set(rows));
  });

  it('handles an empty list and a list with no XCH row', () => {
    expect(orderAssetsByValue([], {})).toEqual([]);
    const ordered = orderAssetsByValue([digRow(1), catRow(CAT_A, 'AAA', 1)], {});
    expect(ordered).toHaveLength(2);
  });

  it('handles a list with no $DIG row (nothing to pin, no crash)', () => {
    const ordered = orderAssetsByValue([xchRow(1), catRow(CAT_A, 'AAA', 1)], {});
    expect(ordered.map((r) => r.descriptor.key)).toEqual(['xch', 'cat']);
  });
});

// #204 — pin XCH + $DIG ABOVE the token filter, excluded from filtering entirely. splitPinnedAssets
// is the single source of truth both the filter predicate and the rendering order rely on.
describe('splitPinnedAssets (#204)', () => {
  it('puts XCH then $DIG in `pinned`, and every other CAT (value-sorted) in `filterable`', () => {
    const prices: PriceMap = { xch: { usd: 10, change24h: null }, [CAT_A]: { usd: 1000, change24h: null } };
    const { pinned, filterable } = splitPinnedAssets([catRow(CAT_A, 'AAA', 5_000_000), digRow(1), xchRow(1)], prices);
    expect(pinned.map((r) => r.descriptor.key)).toEqual(['xch', 'dig']);
    expect(filterable.map((r) => r.descriptor.ticker)).toEqual(['AAA']);
  });

  it('never puts XCH or $DIG in `filterable`, regardless of value ordering', () => {
    const prices: PriceMap = { xch: { usd: 1, change24h: null }, [CAT_A]: { usd: 1_000_000, change24h: null } };
    const { filterable } = splitPinnedAssets([xchRow(1), catRow(CAT_A, 'AAA', 1), digRow(1)], prices);
    expect(filterable.some((r) => r.descriptor.key === 'xch' || r.descriptor.key === 'dig')).toBe(false);
  });

  it('handles a list with neither XCH nor $DIG (empty pinned, no crash)', () => {
    const { pinned, filterable } = splitPinnedAssets([catRow(CAT_A, 'AAA', 1)], {});
    expect(pinned).toEqual([]);
    expect(filterable.map((r) => r.descriptor.ticker)).toEqual(['AAA']);
  });

  it('is a pure reorder: same total length, no row dropped or duplicated', () => {
    const rows = [xchRow(1), digRow(10), catRow(CAT_A, 'AAA', 5), catRow(CAT_B, 'BBB', 2)];
    const { pinned, filterable } = splitPinnedAssets(rows, {});
    expect(pinned.length + filterable.length).toBe(rows.length);
    expect(new Set([...pinned, ...filterable])).toEqual(new Set(rows));
  });
});
