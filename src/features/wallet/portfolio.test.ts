import { describe, it, expect } from 'vitest';
import { pickHeroBalance, balancesAreEmpty } from '@/features/wallet/portfolio';
import type { AssetBalance } from '@/features/wallet/assetTypes';

const xch = (bal: number | null): AssetBalance => ({
  descriptor: { key: 'xch', ticker: 'XCH', name: 'Chia', decimals: 12, assetId: null, type: null },
  balance: bal,
  label: bal == null ? '—' : String(bal / 1e12),
});
const dig = (bal: number | null): AssetBalance => ({
  descriptor: { key: 'dig', ticker: '$DIG', name: 'DIG', decimals: 3, assetId: 'x', type: 'cat' },
  balance: bal,
  label: bal == null ? '—' : String(bal / 1000),
});

describe('portfolio helpers', () => {
  it('picks XCH as the hero when present', () => {
    expect(pickHeroBalance([xch(2_510_000_000_000), dig(1000)])).toEqual({ amountLabel: '2.51', ticker: 'XCH' });
  });

  it('falls back to the first known balance when XCH is unavailable', () => {
    expect(pickHeroBalance([xch(null), dig(1000)])).toEqual({ amountLabel: '1', ticker: '$DIG' });
  });

  it('renders an em dash when nothing is known', () => {
    expect(pickHeroBalance([xch(null)])).toEqual({ amountLabel: '—', ticker: 'XCH' });
    expect(pickHeroBalance(undefined)).toEqual({ amountLabel: '—', ticker: 'XCH' });
  });

  it('reports empty when no asset carries a non-zero balance', () => {
    expect(balancesAreEmpty([])).toBe(true);
    expect(balancesAreEmpty([xch(null), dig(0)])).toBe(true);
    expect(balancesAreEmpty([xch(1)])).toBe(false);
  });
});
