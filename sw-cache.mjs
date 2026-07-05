/**
 * SW-authoritative wallet read cache — the PURE (no chrome.* / DOM) data structures behind the
 * service worker's single-source-of-truth cache for chain/broker reads (CLAUDE.md §3.4/§4).
 *
 * Why this exists: the popup document and the popped-out `app.html` tab are separate JS realms
 * with independent RTK Query caches. Left alone they would each run their own balance/activity
 * scans against the broker — redundant load and *divergent* views. Instead the service worker
 * owns ONE cache: read endpoints resolve through it (a hit returns the memoized value; a miss
 * fetches, stores, returns), and a mutation bumps a per-TAG **epoch** counter that both
 * documents observe (via `chrome.storage.onChanged`) and turn into an RTK Query
 * `invalidateTags`, so every open document converges on one result.
 *
 * This module owns only the pure mechanism — key derivation, a bounded LRU, and the epoch map.
 * The service worker (background.js) wires it to `chrome.storage` + the broker transport, and
 * the popup/app store wires the epoch broadcast to `invalidateTags`. Kept pure so it is unit
 * tested under `node --test` with no browser.
 */

/**
 * Deterministic cache key for a read request. Stable across argument key ordering so two callers
 * that pass the same params in a different property order share one cache entry.
 *
 * @param {string} action the read action name (e.g. 'walletRead')
 * @param {unknown} [params] JSON-serialisable request params
 * @returns {string}
 */
export function cacheKey(action, params) {
  return `${String(action)}::${stableStringify(params)}`;
}

/** JSON.stringify with object keys sorted recursively (arrays keep order). */
export function stableStringify(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/**
 * A bounded, epoch-aware LRU memo for read results.
 *
 * Each entry is stored against the CURRENT epoch of its tag; a later `bumpEpoch(tag)` makes every
 * entry cached under the old epoch a miss (lazy invalidation — no scanning). Entries also carry a
 * TTL: a read older than `ttlMs` is a miss. `max` bounds the entry count (least-recently-used
 * evicted first).
 */
export class WalletCache {
  /** @param {{max?:number, now?:() => number}} [opts] */
  constructor({ max = 64, now = () => Date.now() } = {}) {
    this.max = Math.max(1, max | 0);
    this._now = now;
    /** @type {Map<string,{value:unknown, tag:string, epoch:number, at:number, ttlMs:number}>} */
    this._entries = new Map();
    /** @type {Map<string,number>} tag → current epoch */
    this._epochs = new Map();
  }

  /** Current epoch for a tag (0 if never bumped). */
  epochOf(tag) {
    return this._epochs.get(String(tag)) || 0;
  }

  /**
   * Bump a tag's epoch, invalidating every entry cached under it. Returns the NEW epoch.
   * @param {string} tag
   * @returns {number}
   */
  bumpEpoch(tag) {
    const t = String(tag);
    const next = this.epochOf(t) + 1;
    this._epochs.set(t, next);
    return next;
  }

  /**
   * Read a live (non-stale, current-epoch) entry, or `undefined` on miss. A hit is refreshed to
   * most-recently-used. A stale/expired/superseded entry is dropped and reported as a miss.
   * @param {string} key
   * @returns {unknown|undefined}
   */
  get(key) {
    const e = this._entries.get(key);
    if (!e) return undefined;
    const expired = e.ttlMs > 0 && this._now() - e.at > e.ttlMs;
    const superseded = e.epoch !== this.epochOf(e.tag);
    if (expired || superseded) {
      this._entries.delete(key);
      return undefined;
    }
    // refresh LRU recency
    this._entries.delete(key);
    this._entries.set(key, e);
    return e.value;
  }

  /**
   * Store a read result under `key`, tagged `tag`, valid for `ttlMs` (0 = no TTL). Evicts the LRU
   * entry when over capacity.
   * @param {string} key
   * @param {unknown} value
   * @param {{tag?:string, ttlMs?:number}} [opts]
   */
  set(key, value, { tag = 'default', ttlMs = 0 } = {}) {
    if (this._entries.has(key)) this._entries.delete(key);
    this._entries.set(key, {
      value,
      tag: String(tag),
      epoch: this.epochOf(tag),
      at: this._now(),
      ttlMs: Math.max(0, ttlMs | 0),
    });
    while (this._entries.size > this.max) {
      const oldest = this._entries.keys().next().value;
      this._entries.delete(oldest);
    }
  }

  /** Drop every cached entry (epochs are preserved so in-flight invalidations still hold). */
  clear() {
    this._entries.clear();
  }

  /** Current number of live entries (for tests/diagnostics). */
  get size() {
    return this._entries.size;
  }
}
