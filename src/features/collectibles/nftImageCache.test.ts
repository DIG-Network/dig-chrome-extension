import { describe, it, expect, vi, beforeEach } from 'vitest';
import { selectEvictions, NftImageCache, type ImageBlobStore, type CacheIndexStore, type CacheIndex } from './nftImageCache';

function blob(bytes: number): Blob {
  return { size: bytes } as Blob;
}

/** An in-memory fake honoring the same shape the real Cache-API-backed store does. */
function fakeBlobStore(): ImageBlobStore & { data: Map<string, Blob> } {
  const data = new Map<string, Blob>();
  return {
    data,
    get: vi.fn(async (key: string) => data.get(key)),
    set: vi.fn(async (key: string, b: Blob) => {
      data.set(key, b);
    }),
    delete: vi.fn(async (key: string) => {
      data.delete(key);
    }),
  };
}

function fakeIndexStore(initial: CacheIndex = {}): CacheIndexStore & { data: CacheIndex } {
  const data: CacheIndex = { ...initial };
  return {
    data,
    load: vi.fn(async () => ({ ...data })),
    save: vi.fn(async (index: CacheIndex) => {
      for (const k of Object.keys(data)) delete data[k];
      Object.assign(data, index);
    }),
  };
}

describe('selectEvictions (pure LRU policy)', () => {
  it('evicts nothing when under both caps', () => {
    const index: CacheIndex = { a: { size: 10, lastAccessed: 1 }, b: { size: 10, lastAccessed: 2 } };
    expect(selectEvictions(index, { maxEntries: 10, maxTotalBytes: 1000 })).toEqual([]);
  });

  it('evicts the oldest-accessed entries first when over the entry-count cap', () => {
    const index: CacheIndex = {
      oldest: { size: 1, lastAccessed: 1 },
      middle: { size: 1, lastAccessed: 2 },
      newest: { size: 1, lastAccessed: 3 },
    };
    expect(selectEvictions(index, { maxEntries: 2, maxTotalBytes: 1000 })).toEqual(['oldest']);
  });

  it('evicts oldest-first until under the total-byte cap', () => {
    const index: CacheIndex = {
      a: { size: 40, lastAccessed: 1 },
      b: { size: 40, lastAccessed: 2 },
      c: { size: 40, lastAccessed: 3 },
    };
    // total = 120, cap = 50 → must evict a and b (down to 40, under cap)
    expect(selectEvictions(index, { maxEntries: 100, maxTotalBytes: 50 })).toEqual(['a', 'b']);
  });

  it('applies both caps together', () => {
    const index: CacheIndex = {
      a: { size: 5, lastAccessed: 1 },
      b: { size: 5, lastAccessed: 2 },
      c: { size: 5, lastAccessed: 3 },
    };
    expect(selectEvictions(index, { maxEntries: 1, maxTotalBytes: 1000 })).toEqual(['a', 'b']);
  });
});

describe('NftImageCache', () => {
  let store: ReturnType<typeof fakeBlobStore>;
  let indexStore: ReturnType<typeof fakeIndexStore>;
  let loadImageBlob: ReturnType<typeof vi.fn>;
  let createObjectUrl: ReturnType<typeof vi.fn>;
  let cache: NftImageCache;

  beforeEach(() => {
    store = fakeBlobStore();
    indexStore = fakeIndexStore();
    loadImageBlob = vi.fn(async () => blob(100));
    createObjectUrl = vi.fn((b: Blob) => `blob:mock/${(b as { size: number }).size}-${Math.random()}`);
    cache = new NftImageCache({
      blobStore: store,
      indexStore,
      loadImageBlob,
      maxEntries: 10,
      maxTotalBytes: 10_000,
      maxSingleFileBytes: 1_000,
      now: () => Date.now(),
      createObjectUrl,
    });
  });

  it('loads + caches on a miss, then serves from cache with no re-load on the 2nd call (new instance)', async () => {
    const url = 'https://ipfs.io/ipfs/cid/a.png';
    const src1 = await cache.getOrFetchObjectUrl(url);
    expect(loadImageBlob).toHaveBeenCalledTimes(1);
    expect(src1).toMatch(/^blob:mock\//);
    expect(store.data.has(url)).toBe(true);

    // Simulate a fresh popup/app document: a NEW NftImageCache instance over the SAME persisted
    // stores must still hit the cache — no bookkeeping should live only in the old instance.
    const cache2 = new NftImageCache({ blobStore: store, indexStore, loadImageBlob, createObjectUrl });
    const src2 = await cache2.getOrFetchObjectUrl(url);
    expect(loadImageBlob).toHaveBeenCalledTimes(1); // still 1 — no re-load
    expect(src2).toMatch(/^blob:mock\//);
  });

  it('de-duplicates concurrent requests for the same URL into a single load', async () => {
    const url = 'https://ipfs.io/ipfs/cid/b.png';
    const [a, b] = await Promise.all([cache.getOrFetchObjectUrl(url), cache.getOrFetchObjectUrl(url)]);
    expect(loadImageBlob).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it('propagates a rejected load and does not cache anything for it', async () => {
    const url = 'https://dead.test/x.png';
    const failing = vi.fn(async () => {
      throw new Error('image load failed (dead host or no CORS)');
    });
    cache = new NftImageCache({ blobStore: store, indexStore, loadImageBlob: failing, createObjectUrl });
    await expect(cache.getOrFetchObjectUrl(url)).rejects.toThrow();
    expect(store.data.has(url)).toBe(false);
  });

  it('skips caching (and returns the raw URL) for a file over the single-file size cap', async () => {
    const url = 'https://huge.test/x.png';
    const huge = vi.fn(async () => blob(5000));
    cache = new NftImageCache({ blobStore: store, indexStore, loadImageBlob: huge, maxSingleFileBytes: 1_000, createObjectUrl });
    const src = await cache.getOrFetchObjectUrl(url);
    expect(src).toBe(url); // too big — pass through, don't hold/persist the blob
    expect(store.data.has(url)).toBe(false);
    expect(createObjectUrl).not.toHaveBeenCalled();
  });

  it('evicts the least-recently-used entry once the entry-count cap is exceeded', async () => {
    let t = 0;
    cache = new NftImageCache({
      blobStore: store,
      indexStore,
      loadImageBlob,
      maxEntries: 2,
      maxTotalBytes: 10_000,
      maxSingleFileBytes: 1_000,
      now: () => ++t,
      createObjectUrl,
    });
    await cache.getOrFetchObjectUrl('https://a.test/1.png');
    await cache.getOrFetchObjectUrl('https://a.test/2.png');
    await cache.getOrFetchObjectUrl('https://a.test/3.png');
    expect(store.data.has('https://a.test/1.png')).toBe(false); // evicted (oldest)
    expect(store.data.has('https://a.test/2.png')).toBe(true);
    expect(store.data.has('https://a.test/3.png')).toBe(true);
  });

  it('evicts the least-recently-used entry once the total-bytes cap is exceeded', async () => {
    let t = 0;
    const bigLoad = vi.fn(async () => blob(60));
    cache = new NftImageCache({
      blobStore: store,
      indexStore,
      loadImageBlob: bigLoad,
      maxEntries: 100,
      maxTotalBytes: 100, // only ~1.6 entries of 60 bytes fit
      maxSingleFileBytes: 1_000,
      now: () => ++t,
      createObjectUrl,
    });
    await cache.getOrFetchObjectUrl('https://a.test/1.png');
    await cache.getOrFetchObjectUrl('https://a.test/2.png');
    expect(store.data.has('https://a.test/1.png')).toBe(false);
    expect(store.data.has('https://a.test/2.png')).toBe(true);
  });

  it('touching a cached entry again refreshes its recency so it is not the next eviction victim', async () => {
    let t = 0;
    cache = new NftImageCache({
      blobStore: store,
      indexStore,
      loadImageBlob,
      maxEntries: 2,
      maxTotalBytes: 10_000,
      maxSingleFileBytes: 1_000,
      now: () => ++t,
      createObjectUrl,
    });
    await cache.getOrFetchObjectUrl('https://a.test/1.png'); // t=1
    await cache.getOrFetchObjectUrl('https://a.test/2.png'); // t=2
    await cache.getOrFetchObjectUrl('https://a.test/1.png'); // t=3 (re-access #1 — cache hit)
    await cache.getOrFetchObjectUrl('https://a.test/3.png'); // t=4 — evicts LRU, which is now #2
    expect(store.data.has('https://a.test/1.png')).toBe(true);
    expect(store.data.has('https://a.test/2.png')).toBe(false);
    expect(store.data.has('https://a.test/3.png')).toBe(true);
  });
});
