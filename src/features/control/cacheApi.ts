import { api } from '@/api/api';
import { ACTIONS } from '@/lib/messages';
import type { CachedEntry, CacheStats } from '@/lib/dig-cache';

/** `cache.getConfig` result — the reserved cap + live usage. */
export interface CacheConfig {
  cap_bytes: number;
  used_bytes: number;
  cache_dir?: string;
  shared?: boolean;
}

/**
 * The OPEN cache/LRU management surface (#279) — no control token required. Queries provide the
 * `Cache` tag; the cap/evict/clear mutations invalidate it so every view refetches one shared,
 * up-to-date cache picture.
 */
export const cacheApi = api.injectEndpoints({
  endpoints: (build) => ({
    getCacheConfig: build.query<CacheConfig, void>({
      query: () => ({ action: ACTIONS.cacheGetConfig }),
      providesTags: ['Cache'],
    }),
    getCacheStats: build.query<CacheStats, void>({
      query: () => ({ action: ACTIONS.cacheStats }),
      providesTags: ['Cache'],
    }),
    listCached: build.query<{ cached: CachedEntry[] }, void>({
      query: () => ({ action: ACTIONS.cacheList }),
      providesTags: ['Cache'],
    }),
    setCacheCap: build.mutation<{ cap_bytes: number }, { capBytes: number }>({
      query: ({ capBytes }) => ({ action: ACTIONS.cacheSetCap, capBytes }),
      invalidatesTags: ['Cache'],
    }),
    removeCached: build.mutation<{ removed: boolean }, { storeId: string; root: string }>({
      query: ({ storeId, root }) => ({ action: ACTIONS.cacheRemove, storeId, root }),
      invalidatesTags: ['Cache'],
    }),
    clearCache: build.mutation<Record<string, never>, void>({
      query: () => ({ action: ACTIONS.cacheClear }),
      invalidatesTags: ['Cache'],
    }),
  }),
  overrideExisting: false,
});

export const {
  useGetCacheConfigQuery,
  useGetCacheStatsQuery,
  useListCachedQuery,
  useSetCacheCapMutation,
  useRemoveCachedMutation,
  useClearCacheMutation,
} = cacheApi;
