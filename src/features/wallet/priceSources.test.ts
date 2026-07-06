import { describe, it, expect } from 'vitest';
import {
  parseXchUsd,
  parseCatRatesXch,
  buildPriceMap,
  fetchPriceMap,
  COINGECKO_XCH_URL,
  DEXIE_TICKERS_URL,
  PricesUnavailableError,
} from '@/features/wallet/priceSources';
import { DIG_ASSET_ID } from '@/lib/links';

describe('parseXchUsd (CoinGecko simple/price)', () => {
  it('extracts the USD price + 24h change for chia', () => {
    expect(parseXchUsd({ chia: { usd: 1.56, usd_24h_change: -3.63 } })).toEqual({ usd: 1.56, change24h: -3.63 });
  });

  it('returns a null change when the source omits it (price still usable)', () => {
    expect(parseXchUsd({ chia: { usd: 2 } })).toEqual({ usd: 2, change24h: null });
  });

  it('returns null when there is no usable positive price', () => {
    expect(parseXchUsd({ chia: { usd: 0 } })).toBeNull();
    expect(parseXchUsd({ chia: { usd: 'nope' } })).toBeNull();
    expect(parseXchUsd({})).toBeNull();
    expect(parseXchUsd(null)).toBeNull();
  });
});

describe('parseCatRatesXch (dexie v2 tickers)', () => {
  const tickers = {
    tickers: [
      { base_id: DIG_ASSET_ID.toUpperCase(), target_id: 'xch', target_code: 'XCH', last_price: '0.06' },
      { base_id: 'cc'.repeat(32), target_id: 'xch', target_code: 'XCH', last_price: '0.001' },
      // Not priced in XCH — ignored (no USD anchor path).
      { base_id: 'dd'.repeat(32), target_id: 'usds', target_code: 'USDS', last_price: '1.0' },
      // Junk rows are dropped.
      { base_id: 'not-hex', target_id: 'xch', last_price: '5' },
      { base_id: 'ee'.repeat(32), target_id: 'xch', last_price: '0' },
    ],
  };

  it('maps each XCH-quoted CAT id → its XCH last_price (lowercased id, numeric rate)', () => {
    const rates = parseCatRatesXch(tickers);
    expect(rates[DIG_ASSET_ID.toLowerCase()]).toBe(0.06);
    expect(rates['cc'.repeat(32)]).toBe(0.001);
  });

  it('drops non-XCH pairs, non-hex ids, and non-positive rates', () => {
    const rates = parseCatRatesXch(tickers);
    expect(rates['dd'.repeat(32)]).toBeUndefined();
    expect(rates['ee'.repeat(32)]).toBeUndefined();
    expect(Object.keys(rates)).toHaveLength(2);
  });

  it('tolerates junk input', () => {
    expect(parseCatRatesXch(null)).toEqual({});
    expect(parseCatRatesXch({ tickers: 'nope' })).toEqual({});
  });
});

describe('buildPriceMap', () => {
  it('anchors CAT USD prices to the XCH price (rate × XCH-USD), change unknown', () => {
    const map = buildPriceMap({ usd: 2, change24h: -1 }, { [DIG_ASSET_ID.toLowerCase()]: 0.05 });
    expect(map.xch).toEqual({ usd: 2, change24h: -1 });
    expect(map[DIG_ASSET_ID.toLowerCase()]).toEqual({ usd: 0.1, change24h: null });
  });

  it('yields an empty map with no XCH anchor (CATs cannot be USD-priced)', () => {
    expect(buildPriceMap(null, { [DIG_ASSET_ID.toLowerCase()]: 0.05 })).toEqual({});
  });
});

describe('fetchPriceMap', () => {
  function fakeFetch(routes: Record<string, unknown>, fail: string[] = []) {
    return async (url: string) => {
      if (fail.includes(url)) throw new Error('network');
      const body = routes[url];
      return { ok: body !== undefined, json: async () => body } as Response;
    };
  }

  it('combines CoinGecko + dexie into a full price map', async () => {
    const fetchImpl = fakeFetch({
      [COINGECKO_XCH_URL]: { chia: { usd: 2, usd_24h_change: 5 } },
      [DEXIE_TICKERS_URL]: { tickers: [{ base_id: DIG_ASSET_ID, target_id: 'xch', last_price: '0.05' }] },
    });
    const map = await fetchPriceMap(fetchImpl as typeof fetch);
    expect(map.xch.usd).toBe(2);
    expect(map[DIG_ASSET_ID.toLowerCase()].usd).toBeCloseTo(0.1);
  });

  it('degrades gracefully when dexie fails (XCH price still returned)', async () => {
    const fetchImpl = fakeFetch(
      { [COINGECKO_XCH_URL]: { chia: { usd: 2, usd_24h_change: 5 } } },
      [DEXIE_TICKERS_URL],
    );
    const map = await fetchPriceMap(fetchImpl as typeof fetch);
    expect(map.xch.usd).toBe(2);
    expect(Object.keys(map)).toEqual(['xch']);
  });

  it('throws PricesUnavailableError when the XCH anchor is unavailable', async () => {
    const fetchImpl = fakeFetch({ [DEXIE_TICKERS_URL]: { tickers: [] } }, [COINGECKO_XCH_URL]);
    await expect(fetchPriceMap(fetchImpl as typeof fetch)).rejects.toBeInstanceOf(PricesUnavailableError);
  });
});
