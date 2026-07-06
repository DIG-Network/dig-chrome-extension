/**
 * store-refs.mjs — pure reference classification + resolution for the DIG store IN-PAGE
 * INTERCEPTOR (issue #55).
 *
 * WHY THIS EXISTS: when the extension renders an HTML document loaded from a DIG store, that
 * document's relative links + asset references (`./style.css`, `/img/x.png`, a relative
 * `<a href>`, a relative `fetch()`) have no real origin to resolve against — the rendered store
 * doc lives in a sandboxed frame with an opaque origin, so the browser resolves them to garbage
 * and every asset/link breaks. The *.on.dig.net loader solves the identical problem by serving
 * the store on a real origin and intercepting in-scope requests in a service worker, rewriting
 * each back into a `chia://` read against the SAME capsule. MV3 cannot register a page service
 * worker onto the rendered store document, so the extension mirrors on.dig.net's Tier-2 in-page
 * interceptor (`services/on.dig.net/assets/dig-embed.js`): it patches fetch/XHR and rewrites DOM
 * src/href in-page. This module is the pure decision core that interceptor consumes.
 *
 * SINGLE SOURCE OF TRUTH: the algorithms mirror on.dig.net `dig-embed.js` / `embed-core`
 * (classifyReference / resolveRelativeResourceKey / contentType) so a store renders identically
 * in the extension and on its `*.on.dig.net` subdomain. Pure + DOM-free so it is unit-tested
 * under `node --test`; the browser glue (store-interceptor + dig-viewer) is Playwright-tested.
 */

/** A resolved store reference: a capsule (`storeId`[:`root`]) + a resource key (+ optional salt). */
export interface StoreRef {
  storeId: string;
  root?: string | null;
  resourceKey?: string;
  salt?: string | null;
}
/** A parsed absolute DIG reference (`chia://` / `urn:dig:chia:`). */
export interface ParsedDigRef {
  storeId: string;
  root: string | null;
  resourceKey: string;
  salt: string | null;
}
/** Context for {@link classifyReference}: the current capsule + the current document's key. */
export interface ClassifyContext {
  cfg?: { storeId?: string; root?: string | null; salt?: string | null } | null;
  baseKey?: string;
  pageOrigin?: string | null;
}
/** How the interceptor must treat a single reference. */
export type ClassifiedRef =
  | { kind: 'urn'; ref: StoreRef & { storeId: string; resourceKey: string } }
  | { kind: 'relative'; ref: StoreRef & { storeId: string; resourceKey: string } }
  | { kind: 'external' };

/** Strip a `?query` and `#fragment` from a path/ref, leaving just the path portion. */
export function stripQueryHash(p: unknown): string {
  return String(p == null ? '' : p).split('#')[0].split('?')[0];
}

/**
 * Collapse `.`/`..`/empty segments in a path, returning an absolute-normalised `/a/b` form.
 * A `..` that would escape the root is clamped at the root (never produces `/../`), matching the
 * on.dig.net resolver's path handling.
 */
export function normalizePath(path: unknown): string {
  const parts = String(path == null ? '' : path).split('/');
  const out = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length) out.pop();
      continue;
    }
    out.push(part);
  }
  return '/' + out.join('/');
}

/**
 * Resolve a reference against the CURRENT document's resource key, returning a store-relative
 * resource key (no leading slash).
 *   - a root-absolute ref (`/img/x.png`) resolves against the store root;
 *   - a document-relative ref (`x.png`, `./x`, `../x`) resolves against the current doc's directory.
 * Resolving against the current doc's key (not a fixed entry) keeps multi-page stores correct:
 * `../assets/app.js` from `docs/sub/p.html` is `docs/assets/app.js`.
 */
export function resolveRelativeResourceKey(baseKey: string | null | undefined, ref: unknown): string {
  const cleaned = stripQueryHash(ref);
  if (cleaned === '') return String(baseKey || '').replace(/^\/+/, '');
  if (cleaned.charAt(0) === '/') return normalizePath(cleaned).replace(/^\/+/, '');
  const base = String(baseKey || '');
  const baseDir = base.indexOf('/') !== -1 ? base.slice(0, base.lastIndexOf('/')) : '';
  const joined = (baseDir ? baseDir + '/' : '') + cleaned;
  return normalizePath(joined).replace(/^\/+/, '');
}

/**
 * Parse an absolute DIG reference — `chia://<storeId>[:<root>]/<resourceKey>[?salt=<hex>]` or the
 * `urn:dig:chia:` form — into `{ storeId, root, resourceKey, salt }`, or `null` if it is not a
 * well-formed DIG ref. `storeId` (and `root`, when present) MUST be 64-hex; a missing resource
 * defaults to `index.html`. Mirrors on.dig.net `dig-embed.js` `parseDigRef`.
 */
export function parseDigRef(raw: unknown): ParsedDigRef | null {
  let s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  if (s.indexOf('urn:dig:chia:') === 0) s = s.slice('urn:dig:chia:'.length);
  else if (s.indexOf('chia://') === 0) s = s.slice('chia://'.length);
  else return null;

  let salt = null;
  const qi = s.indexOf('?');
  if (qi !== -1) {
    const qs = new URLSearchParams(s.slice(qi + 1));
    const v = qs.get('salt');
    salt = v && /^[0-9a-fA-F]+$/.test(v) ? v.toLowerCase() : null;
    s = s.slice(0, qi);
  }
  const slash = s.indexOf('/');
  const head = slash === -1 ? s : s.slice(0, slash);
  let resourceKey = slash === -1 ? '' : s.slice(slash + 1);
  resourceKey = stripQueryHash(resourceKey).replace(/^\/+/, '') || 'index.html';
  const colon = head.indexOf(':');
  const storeId = (colon === -1 ? head : head.slice(0, colon)).toLowerCase();
  const root = colon === -1 ? null : head.slice(colon + 1).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(storeId)) return null;
  if (root && !/^[0-9a-f]{64}$/.test(root)) return null;
  return { storeId, root: root || null, resourceKey, salt };
}

/** Build the same-capsule relative result, or `external` when there is no store to resolve into. */
function relativeResult(path: unknown, cfg: ClassifyContext['cfg'], baseKey?: string): ClassifiedRef {
  if (!cfg || !cfg.storeId) return { kind: 'external' };
  return {
    kind: 'relative',
    ref: {
      storeId: cfg.storeId,
      root: cfg.root || 'latest',
      resourceKey: resolveRelativeResourceKey(baseKey || 'index.html', path),
      salt: cfg.salt || null,
    },
  };
}

/**
 * Classify a single reference the way the interceptor must treat it:
 *   - `{ kind: 'urn', ref }`      — an absolute `chia://` / `urn:dig:chia:` ref (may target
 *                                    another capsule); a rootless/saltless ref inherits the
 *                                    current capsule's root/salt fallback.
 *   - `{ kind: 'relative', ref }` — a store-relative link/asset, resolved against the current
 *                                    document into a same-capsule `ref` to read over RPC.
 *   - `{ kind: 'external' }`      — anything else (http(s)/protocol-relative/`data:`/`mailto:`/
 *                                    in-page `#anchor`/`javascript:`/empty): left untouched.
 * `ctx = { cfg: { storeId, root, salt }, baseKey, pageOrigin }`.
 */
export function classifyReference(rawRef: unknown, ctx?: ClassifyContext): ClassifiedRef {
  const cfg = ctx && ctx.cfg;
  const baseKey = (ctx && ctx.baseKey) || 'index.html';
  const pageOrigin = ctx && ctx.pageOrigin;
  const ref = String(rawRef == null ? '' : rawRef).trim();
  if (!ref) return { kind: 'external' };

  if (ref.indexOf('chia://') === 0 || ref.indexOf('urn:dig:chia:') === 0) {
    const parsed = parseDigRef(ref);
    if (!parsed) return { kind: 'external' };
    return {
      kind: 'urn',
      ref: {
        storeId: parsed.storeId,
        root: parsed.root || (cfg && cfg.root) || 'latest',
        resourceKey: parsed.resourceKey,
        salt: parsed.salt || (cfg && cfg.salt) || null,
      },
    };
  }

  // Any other explicit scheme (`https:`, `data:`, `mailto:`, `javascript:` …) is external, EXCEPT
  // a same-page-origin absolute URL, which we fold back to a store-relative path (parity with
  // on.dig.net dig-embed). In the extension's opaque sandbox pageOrigin is usually "null", so this
  // branch is rarely taken — external stays external.
  if (/^(?:[a-z][a-z0-9+.-]*:)/i.test(ref)) {
    if (pageOrigin && pageOrigin !== 'null' && (ref.indexOf(pageOrigin + '/') === 0 || ref === pageOrigin)) {
      return relativeResult(ref.slice(pageOrigin.length) || '/', cfg, baseKey);
    }
    return { kind: 'external' };
  }

  if (ref.indexOf('//') === 0) return { kind: 'external' }; // protocol-relative
  if (ref.charAt(0) === '#') return { kind: 'external' }; // in-page anchor
  return relativeResult(ref, cfg, baseKey);
}

/**
 * Build the `chia://` URL the background `proxyRequest` reads, from a resolved ref.
 *
 * The body is emitted CHAIN-PREFIXED — `chia://chia:<storeId>[:<root>]/<key>` — the same shape
 * the omnibox produces for a pasted `urn:dig:chia:` value. The prefix is load-bearing: the shared
 * `parseURN` reads the FIRST `:`-delimited token as the chain, so a bare `chia://<storeId>:<root>/`
 * would be mis-parsed (the storeId taken as the chain, the root as the storeId). With the explicit
 * `chia:` chain, `parseURN` recovers `{ storeId, roothash }` correctly for both the rooted and the
 * rootless case. A `latest` (or null) root is emitted ROOTLESS (the background treats a rootless
 * URN as the latest capsule); a concrete 64-hex root pins the capsule. A private-store salt rides
 * as `?salt=<hex>`.
 */
export function buildDigUrl(ref: StoreRef): string {
  const storeId = ref.storeId;
  const root = ref.root && ref.root !== 'latest' ? ref.root : null;
  const resourceKey = ref.resourceKey || 'index.html';
  let url = 'chia://chia:' + storeId + (root ? ':' + root : '') + '/' + resourceKey;
  if (ref.salt) url += '?salt=' + ref.salt;
  return url;
}

/**
 * Infer a MIME type from a resource key's extension. SINGLE SOURCE OF TRUTH mirror of the
 * on.dig.net resolver SW / dig-embed `contentType` map — a store's resources MUST serve with the
 * same content type in the extension as on its `*.on.dig.net` subdomain. Keep in sync.
 */
export function contentType(resourceKey: string): string {
  const ext = (String(resourceKey || '').split('.').pop() || '').toLowerCase();
  return (
    {
      html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
      js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
      css: 'text/css; charset=utf-8', json: 'application/json',
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
      svg: 'image/svg+xml', webp: 'image/webp', ico: 'image/x-icon', avif: 'image/avif',
      woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
      txt: 'text/plain', pdf: 'application/pdf', mp4: 'video/mp4', webm: 'video/webm',
      mp3: 'audio/mpeg', wasm: 'application/wasm', xml: 'application/xml', md: 'text/markdown',
    }[ext] || 'application/octet-stream'
  );
}
