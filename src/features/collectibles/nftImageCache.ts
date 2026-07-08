/**
 * Local byte-cache for remote NFT art (#159), keyed by the resolved image URL (`nftImageSrc`'s
 * `data:`-URI output is never cached — it is already inline, zero-network). NFT art is immutable per
 * URI (an `ipfs://` CID's content never changes; a marketplace CDN URL for a minted NFT is likewise
 * treated as content-addressed for this purpose), so caching by URL is safe forever — no
 * invalidation is needed, and a cache hit is served with NO re-fetch of the remote host (a privacy
 * win: fewer repeat requests reveal the wallet's IP to the art's hosting gateway/CDN — see SPEC.md
 * §18.11).
 *
 * NOT the prohibited content cache: `src/test/no-content-cache.test.ts` pins the absence of any
 * cache for RESOLVED/DECRYPTED `chia://`/DIG-store content (that verify-then-decrypt trustless read
 * path must stay live — caching it is the dig-node's job, not the extension's, #43/#41). This module
 * caches ordinary third-party HTTPS/IPFS-gateway image bytes referenced by on-chain NFT metadata —
 * the same category of request as the (already uncached) `icons.dexie.space` CAT icon fetches — and
 * has nothing to do with the DIG node-resolution/verification pipeline.
 *
 * Loaded via `<img>` + canvas, NOT `fetch()` (deliberate — see `loadImageBlobViaCanvas`), predating
 * #98's `connect-src` widening to `https:` (manifest.json, required for `getNftMetadata` to reach an
 * arbitrary off-chain metadata host — see `nft-offchain-metadata.ts`'s doc comment). Kept this way on
 * purpose even though a raw `fetch(url)` is no longer CSP-blocked here: reading a JSON response back
 * into script is a materially bigger exfiltration surface for a compromised page script than
 * `<img>` bytes are (an `<img>` load without `crossOrigin` never exposes its pixels to script at
 * all), so image bytes stay on the narrower `img-src`-only path while only the JSON-metadata fetch
 * (which genuinely needs to read the response) uses the wider `connect-src` surface.
 *
 * Three concerns are split for testability:
 *   - `selectEvictions` — a pure LRU policy function (given an index + caps, which keys to evict).
 *   - `NftImageCache` — orchestrates get-or-load, in-flight de-dup, and eviction over injected
 *     `ImageBlobStore` (the bytes), `CacheIndexStore` (the size/recency bookkeeping), and
 *     `loadImageBlob` (how to fetch bytes for a miss), so unit tests never need a real browser Cache
 *     API or canvas.
 *   - `CacheApiImageBlobStore` / `chromeStorageIndexStore` / `loadImageBlobViaCanvas` are the real
 *     backends `getSharedNftImageCache()` wires up at runtime (exercised by the Playwright e2e against
 *     the built extension, not jsdom, which has no Cache API / canvas 2D context by default).
 */

/** A key's cached byte size + last-access time, for LRU accounting. */
export interface CacheIndexEntry {
  size: number;
  lastAccessed: number;
}

/** url → its cache bookkeeping. Small enough to persist as one JSON blob. */
export type CacheIndex = Record<string, CacheIndexEntry>;

/** The blob bytes store — one entry per cached image URL. */
export interface ImageBlobStore {
  get(key: string): Promise<Blob | undefined>;
  set(key: string, blob: Blob): Promise<void>;
  delete(key: string): Promise<void>;
}

/** The LRU bookkeeping store — persisted separately from the (potentially large) blob bytes. */
export interface CacheIndexStore {
  load(): Promise<CacheIndex>;
  save(index: CacheIndex): Promise<void>;
}

/**
 * Pure LRU eviction policy: given the current index + caps, return the keys to evict (oldest
 * `lastAccessed` first) so the index would satisfy BOTH the entry-count and total-byte caps. No I/O.
 */
export function selectEvictions(index: CacheIndex, opts: { maxEntries: number; maxTotalBytes: number }): string[] {
  const entries = Object.entries(index).sort((a, b) => a[1].lastAccessed - b[1].lastAccessed);
  let count = entries.length;
  let total = entries.reduce((sum, [, meta]) => sum + meta.size, 0);
  const evict: string[] = [];
  for (const [key, meta] of entries) {
    if (count <= opts.maxEntries && total <= opts.maxTotalBytes) break;
    evict.push(key);
    count -= 1;
    total -= meta.size;
  }
  return evict;
}

export const NFT_IMAGE_CACHE_NAME = 'dig-nft-image-cache-v1';
const INDEX_STORAGE_KEY = 'digNftImageCacheIndex';

const DEFAULT_MAX_ENTRIES = 200;
const DEFAULT_MAX_TOTAL_BYTES = 50 * 1024 * 1024; // 50 MB
const DEFAULT_MAX_SINGLE_FILE_BYTES = 10 * 1024 * 1024; // 10 MB — "skip huge files"

/**
 * Get-or-load-and-cache an image URL as a usable `<img src>`. A cache hit returns an object URL for
 * the cached bytes with NO network request; a miss loads via `loadImageBlob`, persists the bytes
 * (unless it's over `maxSingleFileBytes`, in which case the raw URL is returned unchanged and nothing
 * is persisted), evicts LRU entries over the caps, then returns the object URL. Concurrent calls for
 * the SAME url share one in-flight load. A `loadImageBlob` rejection (dead host, CORS-restricted host
 * — see the module doc comment) propagates to the caller, which falls back to the raw URL
 * (`useCachedNftImageSrc`, `NftDetail.tsx`) rather than caching nothing forever.
 */
export class NftImageCache {
  private readonly blobStore: ImageBlobStore;
  private readonly indexStore: CacheIndexStore;
  private readonly loadImageBlob: (url: string) => Promise<Blob>;
  private readonly maxEntries: number;
  private readonly maxTotalBytes: number;
  private readonly maxSingleFileBytes: number;
  private readonly now: () => number;
  private readonly createObjectUrl: (blob: Blob) => string;
  private readonly objectUrlMemo = new Map<string, { objectUrl: string; size: number }>();
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(opts: {
    blobStore: ImageBlobStore;
    indexStore: CacheIndexStore;
    loadImageBlob?: (url: string) => Promise<Blob>;
    maxEntries?: number;
    maxTotalBytes?: number;
    maxSingleFileBytes?: number;
    now?: () => number;
    createObjectUrl?: (blob: Blob) => string;
  }) {
    this.blobStore = opts.blobStore;
    this.indexStore = opts.indexStore;
    this.loadImageBlob = opts.loadImageBlob ?? loadImageBlobViaCanvas;
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxTotalBytes = opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
    this.maxSingleFileBytes = opts.maxSingleFileBytes ?? DEFAULT_MAX_SINGLE_FILE_BYTES;
    this.now = opts.now ?? (() => Date.now());
    this.createObjectUrl = opts.createObjectUrl ?? ((blob) => URL.createObjectURL(blob));
  }

  async getOrFetchObjectUrl(url: string): Promise<string> {
    // An in-process memo hit is STILL a cache access — refresh its recency too, so an entry kept
    // alive purely by repeated renders within one session doesn't look stale to the LRU policy.
    const memoized = this.objectUrlMemo.get(url);
    if (memoized) {
      await this.touch(url, memoized.size);
      return memoized.objectUrl;
    }
    const pending = this.inflight.get(url);
    if (pending) return pending;

    const p = this.resolve(url).finally(() => this.inflight.delete(url));
    this.inflight.set(url, p);
    return p;
  }

  private async resolve(url: string): Promise<string> {
    const cached = await this.blobStore.get(url);
    if (cached) {
      await this.touch(url, cached.size);
      const objectUrl = this.createObjectUrl(cached);
      this.objectUrlMemo.set(url, { objectUrl, size: cached.size });
      return objectUrl;
    }

    const blob = await this.loadImageBlob(url);

    if (blob.size > this.maxSingleFileBytes) {
      // Too big to cache — let the caller fall back to the raw URL (the browser fetches it
      // directly); don't hold or persist it.
      return url;
    }

    await this.blobStore.set(url, blob);
    await this.touch(url, blob.size);
    await this.evict();

    const objectUrl = this.createObjectUrl(blob);
    this.objectUrlMemo.set(url, { objectUrl, size: blob.size });
    return objectUrl;
  }

  private async touch(url: string, size: number): Promise<void> {
    const index = await this.indexStore.load();
    index[url] = { size, lastAccessed: this.now() };
    await this.indexStore.save(index);
  }

  private async evict(): Promise<void> {
    const index = await this.indexStore.load();
    const toEvict = selectEvictions(index, { maxEntries: this.maxEntries, maxTotalBytes: this.maxTotalBytes });
    if (toEvict.length === 0) return;
    for (const key of toEvict) {
      delete index[key];
      await this.blobStore.delete(key);
      this.objectUrlMemo.delete(key);
    }
    await this.indexStore.save(index);
  }
}

/**
 * Default `loadImageBlob`: loads `url` as an off-screen `<img crossOrigin="anonymous">` (an `img-src`
 * fetch — see the module doc comment for why this isn't a plain `fetch()`) and re-encodes its decoded
 * pixels to a PNG `Blob` via a canvas. `crossOrigin="anonymous"` is required so the canvas isn't
 * "tainted" by cross-origin pixels; a host that does not send `Access-Control-Allow-Origin` fails this
 * load entirely (rejects) rather than silently caching nothing — the caller falls back to embedding
 * the raw URL directly (uncached), which renders fine because a plain `<img src>` (no `crossOrigin`)
 * is NOT subject to CORS for display purposes. Re-encoding to PNG is a lossless but NOT byte-identical
 * copy of the source (fine for the thumbnail/preview use here); the size caps guard against
 * pathological blow-up on large source images.
 */
function loadImageBlobViaCanvas(url: string): Promise<Blob> {
  return new Promise((resolveBlob, rejectBlob) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        rejectBlob(new Error('2D canvas context unavailable'));
        return;
      }
      ctx.drawImage(img, 0, 0);
      canvas.toBlob((blob) => {
        if (blob) resolveBlob(blob);
        else rejectBlob(new Error(`canvas toBlob produced no data: ${url}`));
      }, 'image/png');
    };
    img.onerror = () => rejectBlob(new Error(`image load failed (dead host or no CORS): ${url}`));
    img.src = url;
  });
}

/** Cache-API-backed `ImageBlobStore` — the production backend (real browsers / extension pages). */
class CacheApiImageBlobStore implements ImageBlobStore {
  private cachePromise: Promise<Cache> | null = null;

  private open(): Promise<Cache> {
    if (!this.cachePromise) this.cachePromise = caches.open(NFT_IMAGE_CACHE_NAME);
    return this.cachePromise;
  }

  async get(key: string): Promise<Blob | undefined> {
    const cache = await this.open();
    const res = await cache.match(key);
    return res ? await res.blob() : undefined;
  }

  async set(key: string, blob: Blob): Promise<void> {
    const cache = await this.open();
    await cache.put(key, new Response(blob));
  }

  async delete(key: string): Promise<void> {
    const cache = await this.open();
    await cache.delete(key);
  }
}

/** `chrome.storage.local`-backed `CacheIndexStore` — the production backend. */
const chromeStorageIndexStore: CacheIndexStore = {
  async load() {
    const got = await chrome.storage.local.get(INDEX_STORAGE_KEY);
    return (got[INDEX_STORAGE_KEY] as CacheIndex | undefined) ?? {};
  },
  async save(index) {
    await chrome.storage.local.set({ [INDEX_STORAGE_KEY]: index });
  },
};

let shared: NftImageCache | null = null;

/** The one `NftImageCache` instance the extension's React surfaces share (lazily constructed). */
export function getSharedNftImageCache(): NftImageCache {
  if (!shared) {
    shared = new NftImageCache({ blobStore: new CacheApiImageBlobStore(), indexStore: chromeStorageIndexStore });
  }
  return shared;
}

/** Test-only: force the next `getSharedNftImageCache()` call to build a fresh (real-adapter) instance. */
export function resetSharedNftImageCacheForTests(): void {
  shared = null;
}

/** Test-only: inject a fully-controlled instance (e.g. fake stores + a mocked `loadImageBlob`) as the
 * shared cache, so component tests can drive image loading deterministically without a real browser
 * Cache API or canvas. */
export function setSharedNftImageCacheForTests(cache: NftImageCache): void {
  shared = cache;
}
