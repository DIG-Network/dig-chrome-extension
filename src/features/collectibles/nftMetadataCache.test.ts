import { describe, it, expect, vi } from 'vitest';
import { NftMetadataCache, type NftMetadataCacheMap, type NftMetadataStore } from '@/features/collectibles/nftMetadataCache';

function memoryStore(initial: NftMetadataCacheMap = {}): NftMetadataStore {
  let map = initial;
  return {
    load: () => Promise.resolve(map),
    save: (next) => {
      map = next;
      return Promise.resolve();
    },
  };
}

describe('NftMetadataCache (#98 — off-chain metadata JSON cache)', () => {
  it('a cache miss fetches once and caches the result', async () => {
    const fetchJson = vi.fn().mockResolvedValue({ metadata: { name: 'Cool Cat' } });
    const cache = new NftMetadataCache({ store: memoryStore(), fetchJson });
    const result = await cache.getOrFetch('https://example.test/1.json');
    expect(result).toEqual({ name: 'Cool Cat' });
    expect(fetchJson).toHaveBeenCalledTimes(1);
  });

  it('a cache hit resolves with NO re-fetch', async () => {
    const fetchJson = vi.fn().mockResolvedValue({ metadata: { name: 'Cool Cat' } });
    const store = memoryStore();
    const cache = new NftMetadataCache({ store, fetchJson });
    await cache.getOrFetch('https://example.test/1.json');
    await cache.getOrFetch('https://example.test/1.json');
    expect(fetchJson).toHaveBeenCalledTimes(1);
  });

  it('concurrent calls for the SAME uri share one in-flight fetch', async () => {
    let resolveFetch!: (v: { metadata: unknown }) => void;
    const fetchJson = vi.fn().mockReturnValue(new Promise((res) => { resolveFetch = res; }));
    const cache = new NftMetadataCache({ store: memoryStore(), fetchJson });
    const p1 = cache.getOrFetch('https://example.test/1.json');
    const p2 = cache.getOrFetch('https://example.test/1.json');
    resolveFetch({ metadata: { name: 'X' } });
    await Promise.all([p1, p2]);
    expect(fetchJson).toHaveBeenCalledTimes(1);
  });

  it('a negative fetch result (error envelope) is NOT cached — a later call retries', async () => {
    const fetchJson = vi
      .fn()
      .mockResolvedValueOnce({ success: false, code: 'NETWORK_ERROR', message: 'boom' })
      .mockResolvedValueOnce({ metadata: { name: 'Recovered' } });
    const cache = new NftMetadataCache({ store: memoryStore(), fetchJson });
    const first = await cache.getOrFetch('https://example.test/1.json');
    expect(first).toBeNull();
    const second = await cache.getOrFetch('https://example.test/1.json');
    expect(second).toEqual({ name: 'Recovered' });
    expect(fetchJson).toHaveBeenCalledTimes(2);
  });

  it('evicts the least-recently-accessed entry once the entry-count cap is exceeded', async () => {
    const fetchJson = vi.fn().mockImplementation((uri: string) => Promise.resolve({ metadata: { name: uri } }));
    let now = 0;
    const store = memoryStore();
    const cache = new NftMetadataCache({ store, fetchJson, maxEntries: 2, maxTotalBytes: 1024 * 1024, now: () => now });
    now = 1;
    await cache.getOrFetch('https://example.test/a.json');
    now = 2;
    await cache.getOrFetch('https://example.test/b.json');
    now = 3;
    await cache.getOrFetch('https://example.test/c.json'); // pushes past the 2-entry cap
    const map = await store.load();
    expect(Object.keys(map).sort()).toEqual(['https://example.test/b.json', 'https://example.test/c.json']);
  });

  it('touching a cached entry refreshes its recency so it is not the next eviction candidate', async () => {
    const fetchJson = vi.fn().mockImplementation((uri: string) => Promise.resolve({ metadata: { name: uri } }));
    let now = 0;
    const store = memoryStore();
    const cache = new NftMetadataCache({ store, fetchJson, maxEntries: 2, maxTotalBytes: 1024 * 1024, now: () => now });
    now = 1;
    await cache.getOrFetch('https://example.test/a.json');
    now = 2;
    await cache.getOrFetch('https://example.test/b.json');
    now = 10; // re-access 'a' — it should no longer be the oldest
    await cache.getOrFetch('https://example.test/a.json');
    now = 11;
    await cache.getOrFetch('https://example.test/c.json'); // evicts the now-oldest, which is 'b'
    const map = await store.load();
    expect(Object.keys(map).sort()).toEqual(['https://example.test/a.json', 'https://example.test/c.json']);
  });
});
