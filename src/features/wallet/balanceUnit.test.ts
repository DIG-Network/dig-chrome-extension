import { describe, it, expect } from 'vitest';
import {
  DEFAULT_BALANCE_UNIT,
  BALANCE_UNIT_STORAGE_KEY,
  isBalanceUnit,
  toggleBalanceUnit,
  heroBalanceDisplay,
} from '@/features/wallet/balanceUnit';

const formatUsd = (n: number) => `$${n.toFixed(2)}`;

describe('balance-unit preference (#156)', () => {
  it('defaults to XCH (the honest native unit) and has a stable storage key', () => {
    expect(DEFAULT_BALANCE_UNIT).toBe('xch');
    expect(BALANCE_UNIT_STORAGE_KEY).toBe('wallet.homeBalanceUnit');
  });

  it('validates a stored value, rejecting anything but the two known units', () => {
    expect(isBalanceUnit('usd')).toBe(true);
    expect(isBalanceUnit('xch')).toBe(true);
    expect(isBalanceUnit('eur')).toBe(false);
    expect(isBalanceUnit(undefined)).toBe(false);
    expect(isBalanceUnit(null)).toBe(false);
    expect(isBalanceUnit(42)).toBe(false);
  });

  it('flips between the two units', () => {
    expect(toggleBalanceUnit('xch')).toBe('usd');
    expect(toggleBalanceUnit('usd')).toBe('xch');
  });
});

/**
 * `heroBalanceDisplay` resolves the price-dependent slot's state from the RTK Query flags
 * correctly (a mid-task correction on #156): `loading` gets a skeleton (never the word
 * "unavailable"); `unavailable` is reserved for an actual error or a load that completed with no
 * usable price; `ready` renders the real value. `hasAsset` distinguishes "no balance to price at
 * all" (always unavailable, regardless of whether the price feed itself is still loading) from
 * "there IS a balance, we're just waiting on its price".
 */
describe('heroBalanceDisplay (#156 — prominent/secondary swap)', () => {
  const base = { amountLabel: '2.51', ticker: 'XCH', formatUsd, hasAsset: true };

  it('USD prominent, XCH secondary, when a price is known (ready)', () => {
    const d = heroBalanceDisplay({ ...base, unit: 'usd', usd: 123.45, pricesLoading: false });
    expect(d.prominent).toEqual({ kind: 'value', text: '$123.45' });
    expect(d.secondary).toEqual({ kind: 'value', text: '≈ 2.51 XCH' });
  });

  it('XCH prominent, USD secondary, when a price is known (ready)', () => {
    const d = heroBalanceDisplay({ ...base, unit: 'xch', usd: 123.45, pricesLoading: false });
    expect(d.prominent).toEqual({ kind: 'value', text: '2.51 XCH' });
    expect(d.secondary).toEqual({ kind: 'value', text: '≈ $123.45' });
  });

  it('USD chosen, price still loading: a LOADING skeleton on the prominent slot, never "unavailable"', () => {
    const d = heroBalanceDisplay({ ...base, unit: 'usd', usd: null, pricesLoading: true });
    expect(d.prominent).toEqual({ kind: 'loading', text: null });
    // The native amount doesn't depend on price, so the secondary line is already knowable.
    expect(d.secondary).toEqual({ kind: 'value', text: '≈ 2.51 XCH' });
  });

  it('USD chosen, price genuinely unavailable (loaded, no usable price): native fallback + status, NEVER a broken "$—"', () => {
    const d = heroBalanceDisplay({ ...base, unit: 'usd', usd: null, pricesLoading: false });
    expect(d.prominent).toEqual({ kind: 'value', text: '2.51 XCH' });
    expect(d.prominent.text).not.toContain('$');
    expect(d.secondary).toEqual({ kind: 'status', text: 'wallet.portfolio.unavailable' });
  });

  it('XCH chosen, price still loading: prominent unaffected (native, always known), a LOADING skeleton on the secondary slot', () => {
    const d = heroBalanceDisplay({ ...base, unit: 'xch', usd: null, pricesLoading: true });
    expect(d.prominent).toEqual({ kind: 'value', text: '2.51 XCH' });
    expect(d.secondary).toEqual({ kind: 'loading', text: null });
  });

  it('XCH chosen, price genuinely unavailable: prominent unaffected, secondary reports the honest status', () => {
    const d = heroBalanceDisplay({ ...base, unit: 'xch', usd: null, pricesLoading: false });
    expect(d.prominent).toEqual({ kind: 'value', text: '2.51 XCH' });
    expect(d.secondary).toEqual({ kind: 'status', text: 'wallet.portfolio.unavailable' });
  });

  it('no balance to price at all (hasAsset=false): always "unavailable", NEVER "loading" — even while the price feed itself is still loading', () => {
    const noAsset = { amountLabel: '—', ticker: 'XCH', formatUsd, hasAsset: false };
    const whileLoading = heroBalanceDisplay({ ...noAsset, unit: 'usd', usd: null, pricesLoading: true });
    expect(whileLoading.prominent).toEqual({ kind: 'value', text: '— XCH' });
    expect(whileLoading.secondary).toEqual({ kind: 'status', text: 'wallet.portfolio.unavailable' });

    const settled = heroBalanceDisplay({ ...noAsset, unit: 'usd', usd: null, pricesLoading: false });
    expect(settled.secondary).toEqual({ kind: 'status', text: 'wallet.portfolio.unavailable' });
  });
});
