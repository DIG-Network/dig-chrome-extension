import { createApi, fakeBaseQuery } from '@reduxjs/toolkit/query/react';
import { fetchCatRegistry } from './catMetadata';
import type { CatMetaMap } from './catMetadata';

/**
 * CAT token-metadata RTK Query slice — a SEPARATE api slice from the SW-seam `api` slice (like
 * `priceApi`), because the registry is public, read-only market data fetched DIRECTLY over HTTPS from
 * dexie (`api.dexie.space`, allowed by the extension `host_permissions` + CSP `connect-src`), a
 * different transport from the custody service-worker seam. There is no sensitive data here, so it
 * deliberately does NOT route through the SW/offscreen vault.
 *
 * CACHE TTL — the CAT registry changes SLOWLY (new tokens appear over days, existing ones are
 * stable), so this caches with a LONG TTL: it is treated stale only after {@link REGISTRY_TTL_SECONDS}
 * (6 h) and kept that long after the last subscriber unsubscribes, so opening the popup repeatedly
 * never re-hammers dexie. (Contrast the 120 s price TTL — prices move constantly.) A total failure
 * surfaces as an RTK Query `error` and NEVER blocks balances/discovery, which resolve names via the
 * graceful short-form fallback in `resolveCatMeta`.
 */

/** Long TTL: refetch a registry older than this on a remount; keep it cached this long unsubscribed. */
export const REGISTRY_TTL_SECONDS = 6 * 60 * 60; // 6 hours

export const catMetadataApi = createApi({
  reducerPath: 'catMetadataApi',
  baseQuery: fakeBaseQuery<{ message: string }>(),
  tagTypes: ['CatRegistry'],
  keepUnusedDataFor: REGISTRY_TTL_SECONDS,
  refetchOnMountOrArgChange: REGISTRY_TTL_SECONDS,
  endpoints: (build) => ({
    getCatRegistry: build.query<CatMetaMap, void>({
      queryFn: async () => {
        try {
          return { data: await fetchCatRegistry() };
        } catch (e) {
          return { error: { message: e instanceof Error ? e.message : 'Token registry unavailable' } };
        }
      },
      providesTags: ['CatRegistry'],
    }),
  }),
});

export const { useGetCatRegistryQuery } = catMetadataApi;
