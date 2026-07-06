import { createApi, fakeBaseQuery } from '@reduxjs/toolkit/query/react';
import { fetchPriceMap } from './priceSources';
import type { PriceMap } from './priceTypes';

/**
 * The price RTK Query slice — a SEPARATE api slice from the SW-seam `api` slice on purpose. Prices
 * are public, read-only market data fetched DIRECTLY over HTTPS (CoinGecko + dexie, both allowed by
 * the extension `host_permissions` + CSP `connect-src`) — a fundamentally different transport from
 * the custody service-worker seam (`chromeBaseQuery` → `chrome.runtime.sendMessage`). RTK Query
 * supports multiple api slices exactly for this: each owns its own `baseQuery`. There is no sensitive
 * data here, so it deliberately does NOT route through the SW/offscreen vault.
 *
 * `queryFn` performs the two-source fetch + normalization (`fetchPriceMap`); a total failure surfaces
 * as an RTK Query `error` (→ the four-state "value unavailable" branch) and NEVER blocks balances,
 * which come from the independent `api` slice.
 */

/** Short-TTL cache: refetch on a remount when the data is older than this many seconds. */
export const PRICE_TTL_SECONDS = 120;

export const priceApi = createApi({
  reducerPath: 'priceApi',
  baseQuery: fakeBaseQuery<{ message: string }>(),
  tagTypes: ['Prices'],
  // Keep the map briefly after the last subscriber unsubscribes, and treat it stale after the TTL,
  // so opening the popup repeatedly doesn't hammer the upstream (rate-limited) sources.
  keepUnusedDataFor: PRICE_TTL_SECONDS,
  refetchOnMountOrArgChange: PRICE_TTL_SECONDS,
  endpoints: (build) => ({
    getPrices: build.query<PriceMap, void>({
      queryFn: async () => {
        try {
          return { data: await fetchPriceMap() };
        } catch (e) {
          return { error: { message: e instanceof Error ? e.message : 'Prices unavailable' } };
        }
      },
      providesTags: ['Prices'],
    }),
  }),
});

export const { useGetPricesQuery } = priceApi;
