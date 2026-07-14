import { describe, it, expect, vi, afterEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { feedManifestApi, FEED_MANIFEST_TTL_SECONDS } from '@/features/updates/feedManifestApi';
import { UPDATE_FEED_MANIFEST_URL } from '@/lib/feed-manifest';

/** Spin up an isolated store with just this slice, so the queryFn runs end-to-end. */
function makeStore() {
  return configureStore({
    reducer: { [feedManifestApi.reducerPath]: feedManifestApi.reducer },
    middleware: (getDefault) => getDefault().concat(feedManifestApi.middleware),
    // Batch RTK Query store notifications on the microtask queue rather than the default
    // requestAnimationFrame — same override as src/app/store.ts. Under jsdom, rAF can fire
    // after a test's window is torn down and throw from inside RTK's autoBatchEnhancer,
    // surfacing as a flaky "unhandled error" even though every test passes. `tick`
    // (queueMicrotask) coalesces just as effectively and always drains within the turn.
    enhancers: (getDefaultEnhancers) => getDefaultEnhancers({ autoBatch: { type: 'tick' } }),
  });
}

afterEach(() => vi.restoreAllMocks());

describe('feedManifestApi.getFeedManifest', () => {
  it('has a non-zero cache TTL', () => {
    expect(FEED_MANIFEST_TTL_SECONDS).toBeGreaterThan(0);
  });

  it('resolves the parsed component list from the live feed (fetch mocked)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL) => {
      expect(String(input)).toBe(UPDATE_FEED_MANIFEST_URL);
      return Promise.resolve({
        ok: true,
        json: async () => ({ manifest: { components: [{ name: 'dig-node', version: '0.31.1' }] } }),
      } as Response);
    });
    const store = makeStore();
    const res = await store.dispatch(feedManifestApi.endpoints.getFeedManifest.initiate());
    expect(res.data).toEqual([{ name: 'dig-node', version: '0.31.1' }]);
  });

  it('surfaces an error (never throws) when the feed is unreachable', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    const store = makeStore();
    const res = await store.dispatch(feedManifestApi.endpoints.getFeedManifest.initiate());
    expect(res.data).toBeUndefined();
    expect(res.error).toBeTruthy();
  });
});
