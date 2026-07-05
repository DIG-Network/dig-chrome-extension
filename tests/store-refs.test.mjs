/**
 * Tests for store-refs.mjs — the pure reference classifier + resolver behind the extension's
 * in-page STORE INTERCEPTOR (issue #55). This is the single source of truth for how a store
 * document's relative links + asset references (`./style.css`, `/img/x.png`, relative `<a href>`,
 * relative `fetch()`) are rewritten back into a `chia://` URN that the node/RPC serves — the exact
 * relative-resolution behaviour the *.on.dig.net loader's service worker gives store content.
 *
 * These are pure functions (no DOM, no chrome.*), so they run under `node --test`. The DOM glue
 * that consumes them (store-interceptor + dig-viewer) is browser-only and covered by Playwright.
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  stripQueryHash,
  normalizePath,
  resolveRelativeResourceKey,
  parseDigRef,
  classifyReference,
  contentType,
  buildDigUrl,
} from '../store-refs.mjs';
// Cross-check that a rewritten relative ref round-trips through the SAME parser the background
// service worker uses for proxyRequest — proving the interceptor's URN is one the node accepts.
import { parseURN } from '../dig-urn.mjs';

const STORE = 'a'.repeat(64);
const STORE2 = 'c'.repeat(64);
const ROOT = 'b'.repeat(64);
const ROOT2 = 'd'.repeat(64);

// A capsule config as the interceptor holds it, with the current document's resource key as base.
function ctx(baseKey = 'index.html', overrides = {}) {
  return {
    cfg: { storeId: STORE, root: 'latest', salt: null, ...(overrides.cfg || {}) },
    baseKey,
    pageOrigin: overrides.pageOrigin || 'null',
  };
}

// ---------------------------------------------------------------------------
// stripQueryHash / normalizePath
// ---------------------------------------------------------------------------

test('stripQueryHash removes query and fragment', () => {
  assert.equal(stripQueryHash('style.css?v=2#top'), 'style.css');
  assert.equal(stripQueryHash('a/b.js#x'), 'a/b.js');
  assert.equal(stripQueryHash('plain'), 'plain');
  assert.equal(stripQueryHash(''), '');
  assert.equal(stripQueryHash(null), '');
});

test('normalizePath resolves . and .. segments', () => {
  assert.equal(normalizePath('a/b/../c'), '/a/c');
  assert.equal(normalizePath('a/./b'), '/a/b');
  assert.equal(normalizePath('../../x'), '/x');
  assert.equal(normalizePath('/a//b/'), '/a/b');
  assert.equal(normalizePath(''), '/');
});

// ---------------------------------------------------------------------------
// resolveRelativeResourceKey — the core relative-resolution
// ---------------------------------------------------------------------------

test('resolveRelativeResourceKey: same-dir relative from index.html', () => {
  assert.equal(resolveRelativeResourceKey('index.html', './style.css'), 'style.css');
  assert.equal(resolveRelativeResourceKey('index.html', 'style.css'), 'style.css');
});

test('resolveRelativeResourceKey: root-absolute path is store-root relative', () => {
  assert.equal(resolveRelativeResourceKey('docs/page.html', '/img/logo.png'), 'img/logo.png');
});

test('resolveRelativeResourceKey: relative resolves against the CURRENT document dir', () => {
  assert.equal(resolveRelativeResourceKey('docs/page.html', 'other.html'), 'docs/other.html');
  assert.equal(resolveRelativeResourceKey('docs/page.html', './a/b.js'), 'docs/a/b.js');
  assert.equal(resolveRelativeResourceKey('docs/sub/p.html', '../assets/app.js'), 'docs/assets/app.js');
  assert.equal(resolveRelativeResourceKey('a/b/c.html', '../../x.png'), 'x.png');
});

test('resolveRelativeResourceKey: strips query/hash from the ref', () => {
  assert.equal(resolveRelativeResourceKey('index.html', './style.css?v=2#top'), 'style.css');
});

// ---------------------------------------------------------------------------
// parseDigRef — chia:// / urn:dig:chia: absolute references
// ---------------------------------------------------------------------------

test('parseDigRef parses a rooted chia:// URL', () => {
  assert.deepEqual(parseDigRef(`chia://${STORE}:${ROOT}/app.js`), {
    storeId: STORE, root: ROOT, resourceKey: 'app.js', salt: null,
  });
});

test('parseDigRef parses a rootless urn:dig:chia: URL with default resource', () => {
  assert.deepEqual(parseDigRef(`urn:dig:chia:${STORE}`), {
    storeId: STORE, root: null, resourceKey: 'index.html', salt: null,
  });
});

test('parseDigRef extracts a ?salt= param and rejects non-DIG refs', () => {
  assert.equal(parseDigRef(`chia://${STORE}/a.js?salt=deadBEEF`).salt, 'deadbeef');
  assert.equal(parseDigRef('https://example.com/x'), null);
  assert.equal(parseDigRef('./rel.css'), null);
  assert.equal(parseDigRef(`chia://not-hex/a.js`), null);
});

// ---------------------------------------------------------------------------
// classifyReference — the dispatch the interceptor uses per reference
// ---------------------------------------------------------------------------

test('classifyReference: a relative asset becomes a same-capsule relative ref', () => {
  assert.deepEqual(classifyReference('./style.css', ctx('index.html')), {
    kind: 'relative',
    ref: { storeId: STORE, root: 'latest', resourceKey: 'style.css', salt: null },
  });
});

test('classifyReference: a root-absolute asset resolves against the store root', () => {
  const r = classifyReference('/img/logo.png', ctx('docs/page.html'));
  assert.equal(r.kind, 'relative');
  assert.equal(r.ref.resourceKey, 'img/logo.png');
});

test('classifyReference: carries the pinned root + salt into the resolved ref', () => {
  const r = classifyReference('./app.js', ctx('index.html', { cfg: { storeId: STORE, root: ROOT, salt: 'ab12' } }));
  assert.deepEqual(r.ref, { storeId: STORE, root: ROOT, resourceKey: 'app.js', salt: 'ab12' });
});

test('classifyReference: an absolute chia:// ref is a urn (may target another capsule)', () => {
  const r = classifyReference(`chia://${STORE2}:${ROOT2}/x.html`, ctx());
  assert.equal(r.kind, 'urn');
  assert.deepEqual(r.ref, { storeId: STORE2, root: ROOT2, resourceKey: 'x.html', salt: null });
});

test('classifyReference: a rootless chia:// ref inherits the capsule root/salt fallback', () => {
  const r = classifyReference(`chia://${STORE2}/x.html`, ctx('index.html', { cfg: { storeId: STORE, root: ROOT, salt: 'ff' } }));
  assert.equal(r.kind, 'urn');
  assert.equal(r.ref.root, ROOT);
  assert.equal(r.ref.salt, 'ff');
});

test('classifyReference: external/opaque references are passed through untouched', () => {
  for (const ext of [
    'https://example.com/x.js',
    'http://example.com/x.js',
    '//cdn.example.com/x.js',
    '#in-page-anchor',
    'data:text/plain,hi',
    'mailto:a@b.com',
    'javascript:void 0',
    '',
    null,
  ]) {
    assert.equal(classifyReference(ext, ctx()).kind, 'external', `expected external for ${JSON.stringify(ext)}`);
  }
});

test('classifyReference: with no store in cfg, a relative ref cannot be resolved → external', () => {
  assert.equal(classifyReference('./x.css', { cfg: {}, baseKey: 'index.html', pageOrigin: 'null' }).kind, 'external');
});

test('classifyReference: a same-page-origin absolute URL folds back to a store-relative ref', () => {
  // Parity with on.dig.net dig-embed: when the frame HAS a real origin, an absolute URL on that
  // origin is the store's own content, resolved store-relative (rarely hit in the opaque frame).
  const c = ctx('docs/page.html', { pageOrigin: 'https://x.on.dig.net' });
  const r = classifyReference('https://x.on.dig.net/img/logo.png', c);
  assert.equal(r.kind, 'relative');
  assert.equal(r.ref.resourceKey, 'img/logo.png');
  // The bare origin (no path) folds to the store root and resolves against the current dir.
  assert.equal(classifyReference('https://x.on.dig.net', c).kind, 'relative');
});

// ---------------------------------------------------------------------------
// buildDigUrl — the URN handed to the background proxyRequest
// ---------------------------------------------------------------------------

test('buildDigUrl emits a chain-prefixed rootless chia:// URL for a latest capsule', () => {
  assert.equal(
    buildDigUrl({ storeId: STORE, root: 'latest', resourceKey: 'a.js', salt: null }),
    `chia://chia:${STORE}/a.js`
  );
  // null root is treated the same as latest (rootless)
  assert.equal(
    buildDigUrl({ storeId: STORE, root: null, resourceKey: 'a.js', salt: null }),
    `chia://chia:${STORE}/a.js`
  );
});

test('buildDigUrl pins a concrete root and appends the salt', () => {
  assert.equal(
    buildDigUrl({ storeId: STORE, root: ROOT, resourceKey: 'img/x.png', salt: null }),
    `chia://chia:${STORE}:${ROOT}/img/x.png`
  );
  assert.equal(
    buildDigUrl({ storeId: STORE, root: ROOT, resourceKey: 'a.js', salt: 'abc123' }),
    `chia://chia:${STORE}:${ROOT}/a.js?salt=abc123`
  );
});

test('a rewritten relative ref round-trips through the background parseURN (rooted)', () => {
  // ./style.css on a rooted capsule → chia:// URN → parseURN yields the same capsule + resource.
  const cls = classifyReference('./style.css', ctx('index.html', { cfg: { storeId: STORE, root: ROOT, salt: null } }));
  const url = buildDigUrl(cls.ref);
  assert.equal(url, `chia://chia:${STORE}:${ROOT}/style.css`);
  assert.ok(url.startsWith('chia://')); // accepted by the background proxyRequest guard
  const parsed = parseURN(url);
  assert.equal(parsed.storeId, STORE);
  assert.equal(parsed.roothash, ROOT);
  assert.equal(parsed.resourceKey, 'style.css');
});

test('a rewritten relative ref round-trips through the background parseURN (latest)', () => {
  // /img/x.png on a latest capsule → rootless chia:// URN → parseURN yields the store + resource.
  const cls = classifyReference('/img/x.png', ctx('docs/p.html', { cfg: { storeId: STORE, root: 'latest', salt: null } }));
  const url = buildDigUrl(cls.ref);
  assert.equal(url, `chia://chia:${STORE}/img/x.png`);
  const parsed = parseURN(url);
  assert.equal(parsed.storeId, STORE);
  assert.equal(parsed.roothash, null);
  assert.equal(parsed.resourceKey, 'img/x.png');
});

// ---------------------------------------------------------------------------
// contentType — MIME inference (mirror of the resolver SW + dig-embed map)
// ---------------------------------------------------------------------------

test('contentType infers common MIME types and defaults to octet-stream', () => {
  assert.equal(contentType('index.html'), 'text/html; charset=utf-8');
  assert.equal(contentType('style.css'), 'text/css; charset=utf-8');
  assert.equal(contentType('app.js'), 'text/javascript; charset=utf-8');
  assert.equal(contentType('data.json'), 'application/json');
  assert.equal(contentType('logo.png'), 'image/png');
  assert.equal(contentType('font.woff2'), 'font/woff2');
  assert.equal(contentType('movie.mp4'), 'video/mp4');
  assert.equal(contentType('unknown.xyz'), 'application/octet-stream');
  assert.equal(contentType('noext'), 'application/octet-stream');
});
