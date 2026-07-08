/**
 * Local cache for off-chain NFT metadata JSON (#98), keyed by `metadataUri`. Mirrors the #159
 * `NftImageCache` (`nftImageCache.ts`) design one level simpler: a CHIP-0007 document is small JSON
 * (no Blob/canvas concerns), so ONE `chrome.storage.local` entry holds the whole map (data + LRU
 * bookkeeping together) instead of splitting bytes from an index. Reuses the image cache's exact
 * eviction policy (`selectEvictions`) so the two caches agree on one LRU algorithm.
 *
 * Off-chain metadata is immutable per URI (same content-addressed reasoning as NFT art, #159), so a
 * SUCCESSFUL fetch is cached forever with no invalidation. A NEGATIVE result (network error, invalid
 * JSON, a document with nothing usable) is deliberately NOT cached — a transient failure (a slow or
 * temporarily-down host) gets another chance on the next render/session rather than being pinned as
 * "no metadata" forever.
 */

import { selectEvictions, type CacheIndex } from '@/features/collectibles/nftImageCache';

/** One cached URI's resolved (already-JSON-decoded) document + LRU bookkeeping. */
export interface NftMetadataCacheEntry {
  data: unknown;
  size: number;
  lastAccessed: number;
}

/** uri → its cached document + bookkeeping. Small enough to persist as one JSON blob. */
export type NftMetadataCacheMap = Record<string, NftMetadataCacheEntry>;

/** The persistence backend — swapped for an in-memory fake in tests. */
export interface NftMetadataStore {
  load(): Promise<NftMetadataCacheMap>;
  save(map: NftMetadataCacheMap): Promise<void>;
}

/** The result shape `getNftMetadata` (`src/lib/messages.ts`) replies with. */
export type NftMetadataFetchResult = { metadata: unknown } | { success: false; code: string; message: string };

const DEFAULT_MAX_ENTRIES = 300;
const DEFAULT_MAX_TOTAL_BYTES = 5 * 1024 * 1024; // 5 MB — JSON documents, far smaller than art bytes

/** Approximate byte size of a JSON-serializable value, for the eviction policy's byte cap. */
function approximateJsonSize(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Get-or-fetch-and-cache a `metadataUri`'s off-chain document. A cache hit returns the cached
 * (already-decoded) value with NO network round trip; a miss calls the injected `fetchJson`
 * (production: `chrome.runtime.sendMessage({ action: ACTIONS.getNftMetadata, uri })`), caches a
 * SUCCESS result, and returns `null` for a negative result WITHOUT caching it. Concurrent calls for
 * the same uri share one in-flight fetch.
 */
export class NftMetadataCache {
  private readonly store: NftMetadataStore;
  private readonly fetchJson: (uri: string) => Promise<NftMetadataFetchResult>;
  private readonly maxEntries: number;
  private readonly maxTotalBytes: number;
  private readonly now: () => number;
  private readonly inflight = new Map<string, Promise<unknown | null>>();

  constructor(opts: {
    store: NftMetadataStore;
    fetchJson: (uri: string) => Promise<NftMetadataFetchResult>;
    maxEntries?: number;
    maxTotalBytes?: number;
    now?: () => number;
  }) {
    this.store = opts.store;
    this.fetchJson = opts.fetchJson;
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxTotalBytes = opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
    this.now = opts.now ?? (() => Date.now());
  }

  async getOrFetch(uri: string): Promise<unknown | null> {
    const map = await this.store.load();
    const hit = map[uri];
    if (hit) {
      map[uri] = { ...hit, lastAccessed: this.now() };
      await this.store.save(map);
      return hit.data;
    }

    const pending = this.inflight.get(uri);
    if (pending) return pending;

    const p = this.resolve(uri).finally(() => this.inflight.delete(uri));
    this.inflight.set(uri, p);
    return p;
  }

  private async resolve(uri: string): Promise<unknown | null> {
    const result = await this.fetchJson(uri);
    if (!('metadata' in result)) return null; // negative result — never cached, see doc comment

    const map = await this.store.load();
    map[uri] = { data: result.metadata, size: approximateJsonSize(result.metadata), lastAccessed: this.now() };

    const toEvict = selectEvictions(map as unknown as CacheIndex, { maxEntries: this.maxEntries, maxTotalBytes: this.maxTotalBytes });
    for (const key of toEvict) delete map[key];

    await this.store.save(map);
    return result.metadata;
  }
}

const STORAGE_KEY = 'digNftMetadataCache';

/** `chrome.storage.local`-backed `NftMetadataStore` — the production backend. */
const chromeMetadataStore: NftMetadataStore = {
  async load() {
    const got = await chrome.storage.local.get(STORAGE_KEY);
    return (got[STORAGE_KEY] as NftMetadataCacheMap | undefined) ?? {};
  },
  async save(map) {
    await chrome.storage.local.set({ [STORAGE_KEY]: map });
  },
};

let shared: NftMetadataCache | null = null;

/** The one `NftMetadataCache` instance the extension's React surfaces share (lazily constructed). */
export function getSharedNftMetadataCache(fetchJson: (uri: string) => Promise<NftMetadataFetchResult>): NftMetadataCache {
  if (!shared) {
    shared = new NftMetadataCache({ store: chromeMetadataStore, fetchJson });
  }
  return shared;
}

/** Test-only: force the next `getSharedNftMetadataCache()` call to build a fresh instance. */
export function resetSharedNftMetadataCacheForTests(): void {
  shared = null;
}
