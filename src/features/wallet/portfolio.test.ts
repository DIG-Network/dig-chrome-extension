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
  it('picks XCH as the hero when present, carrying its own asset row for USD conversion (#156)', () => {
    const xchRow = xch(2_510_000_000_000);
    expect(pickHeroBalance([xchRow, dig(1000)])).toEqual({ amountLabel: '2.51', ticker: 'XCH', asset: xchRow });
  });

  it('falls back to the first known balance when XCH is unavailable', () => {
    const digRow = dig(1000);
    expect(pickHeroBalance([xch(null), digRow])).toEqual({ amountLabel: '1', ticker: '$DIG', asset: digRow });
  });

  it('renders an em dash when nothing is known, with no asset row to price', () => {
    expect(pickHeroBalance([xch(null)])).toEqual({ amountLabel: '—', ticker: 'XCH', asset: null });
    expect(pickHeroBalance(undefined)).toEqual({ amountLabel: '—', ticker: 'XCH', asset: null });
  });

  it('reports empty when no asset carries a non-zero balance', () => {
    expect(balancesAreEmpty([])).toBe(true);
    expect(balancesAreEmpty([xch(null), dig(0)])).toBe(true);
    expect(balancesAreEmpty([xch(1)])).toBe(false);
  });
});
