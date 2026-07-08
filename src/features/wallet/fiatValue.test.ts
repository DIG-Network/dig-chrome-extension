import { describe, it, expect } from 'vitest';
import { resolveFiatValue } from '@/features/wallet/fiatValue';

/**
 * #112/#158 — the fiat-conversion layer's own four-state rule: a KNOWN usd amount converts to the
 * chosen currency when the rate is known; while the rate is still loading it's a `loading` state
 * (never "unavailable" mid-fetch, #158); once loading settles with no usable rate, it gracefully
 * DEGRADES to the USD amount (still an honest real value) rather than showing "unavailable" —
 * conversion failure never blocks the wallet from showing a number.
 */
describe('resolveFiatValue', () => {
  it('passes the USD amount through unchanged when the chosen currency IS usd', () => {
    const v = resolveFiatValue({ usd: 12.34, fiat: 'usd', fxRates: undefined, fxLoading: false });
    expect(v).toEqual({ kind: 'value', amount: 12.34, currency: 'usd' });
  });

  it('converts using the known rate for a non-USD currency', () => {
    const v = resolveFiatValue({ usd: 10, fiat: 'eur', fxRates: { eur: 0.9 }, fxLoading: false });
    expect(v).toEqual({ kind: 'value', amount: 9, currency: 'eur' });
  });

  it('is a loading state while the rate is still being fetched (never "unavailable")', () => {
    const v = resolveFiatValue({ usd: 10, fiat: 'eur', fxRates: undefined, fxLoading: true });
    expect(v).toEqual({ kind: 'loading' });
  });

  it('gracefully degrades to USD when the rate load has settled with no usable rate', () => {
    const v = resolveFiatValue({ usd: 10, fiat: 'eur', fxRates: {}, fxLoading: false });
    expect(v).toEqual({ kind: 'value', amount: 10, currency: 'usd' });
  });

  it('treats a non-finite or non-positive rate as missing', () => {
    expect(resolveFiatValue({ usd: 10, fiat: 'eur', fxRates: { eur: 0 }, fxLoading: false })).toEqual({
      kind: 'value',
      amount: 10,
      currency: 'usd',
    });
    expect(resolveFiatValue({ usd: 10, fiat: 'eur', fxRates: { eur: Number.NaN }, fxLoading: false })).toEqual({
      kind: 'value',
      amount: 10,
      currency: 'usd',
    });
  });
});
