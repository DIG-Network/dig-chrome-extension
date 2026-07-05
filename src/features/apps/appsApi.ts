import { api } from '@/api/api';
import { STORE_JSON_URL, STORE_CACHE_KEY, normalizeCatalog, type StoreCatalog, type StoreApp } from '@/features/apps/storeCatalog';

/**
 * The dApp-store catalog endpoint (#65). Unlike the other endpoints (which speak the SW seam), this
 * one fetches explore.dig.net's public `/store.json` DIRECTLY (CORS `*`; host is in
 * `connect-src`/`host_permissions`) via a custom `queryFn`, and caches the last good result in
 * `chrome.storage.local` for stale-while-revalidate: a network success refreshes the cache and
 * returns fresh; a failure falls back to the cached copy (`stale:true`) so the launcher still paints
 * and works offline. No decrypted key or SW involvement — it's a public read.
 */

/** How long to wait for `/store.json` before falling back to the cache (ms). */
const FETCH_TIMEOUT = 10_000;

async function readCache(): Promise<StoreApp[] | null> {
  try {
    const got = await chrome.storage?.local?.get(STORE_CACHE_KEY);
    const cached = got?.[STORE_CACHE_KEY] as { apps?: unknown } | undefined;
    return Array.isArray(cached?.apps) ? (cached!.apps as StoreApp[]) : null;
  } catch {
    return null;
  }
}

async function writeCache(apps: StoreApp[]): Promise<void> {
  try {
    await chrome.storage?.local?.set({ [STORE_CACHE_KEY]: { apps, at: Date.now() } });
  } catch {
    /* cache is best-effort */
  }
}

export const appsApi = api.injectEndpoints({
  endpoints: (build) => ({
    getStoreCatalog: build.query<StoreCatalog, void>({
      queryFn: async () => {
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
          const res = await fetch(STORE_JSON_URL, { signal: ctrl.signal, credentials: 'omit' });
          clearTimeout(timer);
          if (!res.ok) throw new Error(`store.json ${res.status}`);
          const apps = normalizeCatalog(await res.json());
          await writeCache(apps);
          return { data: { apps, stale: false } };
        } catch {
          const cached = await readCache();
          if (cached) return { data: { apps: cached, stale: true } };
          return { error: { code: 'STORE_UNAVAILABLE', message: 'The dApp store is unavailable' } };
        }
      },
    }),
  }),
  overrideExisting: false,
});

export const { useGetStoreCatalogQuery } = appsApi;
