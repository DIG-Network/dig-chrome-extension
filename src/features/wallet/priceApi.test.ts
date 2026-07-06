import { describe, it, expect, vi, afterEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { priceApi, PRICE_TTL_SECONDS } from '@/features/wallet/priceApi';
import { COINGECKO_XCH_URL } from '@/features/wallet/priceSources';
import { DIG_ASSET_ID } from '@/lib/links';

/** Spin up an isolated store with just the price slice, so the queryFn runs end-to-end. */
function makeStore() {
  return configureStore({
    reducer: { [priceApi.reducerPath]: priceApi.reducer },
    middleware: (getDefault) => getDefault().concat(priceApi.middleware),
  });
}

afterEach(() => vi.restoreAllMocks());

describe('priceApi.getPrices', () => {
  it('has a short (non-zero) cache TTL', () => {
    expect(PRICE_TTL_SECONDS).toBeGreaterThan(0);
  });

  it('resolves a PriceMap from the two live sources (fetch mocked)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      const body =
        url === COINGECKO_XCH_URL
          ? { chia: { usd: 4, usd_24h_change: 2 } }
          : { tickers: [{ base_id: DIG_ASSET_ID, target_id: 'xch', last_price: '0.25' }] };
      return Promise.resolve({ ok: true, json: async () => body } as Response);
    });
    const store = makeStore();
    const res = await store.dispatch(priceApi.endpoints.getPrices.initiate());
    expect(res.data?.xch).toEqual({ usd: 4, change24h: 2 });
    expect(res.data?.[DIG_ASSET_ID.toLowerCase()].usd).toBeCloseTo(1); // 0.25 XCH × $4
  });

  it('surfaces an error (never throws) when prices are unavailable', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    const store = makeStore();
    const res = await store.dispatch(priceApi.endpoints.getPrices.initiate());
    expect(res.data).toBeUndefined();
    expect(res.error).toBeTruthy();
  });
});
