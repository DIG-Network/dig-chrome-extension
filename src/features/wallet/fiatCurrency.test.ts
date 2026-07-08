import { describe, it, expect } from 'vitest';
import { SUPPORTED_FIAT_CURRENCIES, DEFAULT_FIAT_CURRENCY, FIAT_CURRENCY_STORAGE_KEY, isFiatCode } from '@/features/wallet/fiatCurrency';

describe('fiatCurrency', () => {
  it('ships a non-trivial supported set, USD first', () => {
    expect(SUPPORTED_FIAT_CURRENCIES.length).toBeGreaterThanOrEqual(10);
    expect(SUPPORTED_FIAT_CURRENCIES[0].code).toBe('usd');
  });

  it('every entry has a unique code + a display symbol', () => {
    const codes = SUPPORTED_FIAT_CURRENCIES.map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const c of SUPPORTED_FIAT_CURRENCIES) {
      expect(c.symbol.length).toBeGreaterThan(0);
    }
  });

  it('defaults to USD', () => {
    expect(DEFAULT_FIAT_CURRENCY).toBe('usd');
  });

  it('persists under a dedicated storage key', () => {
    expect(FIAT_CURRENCY_STORAGE_KEY).toBe('wallet.fiatCurrency');
  });

  it('isFiatCode guards a stored value read back from chrome.storage', () => {
    for (const c of SUPPORTED_FIAT_CURRENCIES) expect(isFiatCode(c.code)).toBe(true);
    expect(isFiatCode('xau')).toBe(false);
    expect(isFiatCode(undefined)).toBe(false);
    expect(isFiatCode(null)).toBe(false);
    expect(isFiatCode(42)).toBe(false);
  });
});
