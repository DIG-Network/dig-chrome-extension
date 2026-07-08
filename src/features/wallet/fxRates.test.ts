import { describe, it, expect } from 'vitest';
import { parseFxRates, fetchFxRates, COINGECKO_FX_URL, FxRatesUnavailableError } from '@/features/wallet/fxRates';

describe('parseFxRates', () => {
  it('computes fiat-per-USD ratios from a CoinGecko multi-currency simple/price response', () => {
    const rates = parseFxRates({ chia: { usd: 2, eur: 1.8, jpy: 300, gbp: 1.6 } });
    expect(rates.usd).toBe(1);
    expect(rates.eur).toBeCloseTo(0.9); // 1.8 / 2
    expect(rates.jpy).toBeCloseTo(150); // 300 / 2
    expect(rates.gbp).toBeCloseTo(0.8); // 1.6 / 2
  });

  it('omits a currency the response does not report', () => {
    const rates = parseFxRates({ chia: { usd: 2, eur: 1.8 } });
    expect(rates.eur).toBeCloseTo(0.9);
    expect(rates.jpy).toBeUndefined();
  });

  it('omits a non-finite or non-positive rate', () => {
    const rates = parseFxRates({ chia: { usd: 2, eur: 0, gbp: 'nope', jpy: -5 } });
    expect(rates.eur).toBeUndefined();
    expect(rates.gbp).toBeUndefined();
    expect(rates.jpy).toBeUndefined();
  });

  it('returns an empty map when there is no usable USD anchor', () => {
    expect(parseFxRates({ chia: { eur: 1.8 } })).toEqual({});
    expect(parseFxRates({ chia: { usd: 0, eur: 1.8 } })).toEqual({});
    expect(parseFxRates(null)).toEqual({});
    expect(parseFxRates({})).toEqual({});
  });
});

describe('fetchFxRates', () => {
  function fakeFetch(body: unknown, ok = true) {
    return async () => ({ ok, json: async () => body }) as Response;
  }

  it('resolves the fiat-per-USD map on success', async () => {
    const fetchImpl = fakeFetch({ chia: { usd: 2, eur: 1.8 } });
    const rates = await fetchFxRates(fetchImpl as typeof fetch);
    expect(rates.usd).toBe(1);
    expect(rates.eur).toBeCloseTo(0.9);
  });

  it('throws FxRatesUnavailableError on a non-2xx response', async () => {
    const fetchImpl = fakeFetch({}, false);
    await expect(fetchFxRates(fetchImpl as typeof fetch)).rejects.toBeInstanceOf(FxRatesUnavailableError);
  });

  it('throws FxRatesUnavailableError when the response has no usable USD anchor', async () => {
    const fetchImpl = fakeFetch({ chia: {} });
    await expect(fetchFxRates(fetchImpl as typeof fetch)).rejects.toBeInstanceOf(FxRatesUnavailableError);
  });

  it('requests every supported currency in one call', () => {
    expect(COINGECKO_FX_URL).toContain('vs_currencies=');
    expect(COINGECKO_FX_URL).toContain('usd');
    expect(COINGECKO_FX_URL).toContain('eur');
    expect(COINGECKO_FX_URL).toContain('inr');
  });
});
