/**
 * Pinning tests for the unified URN parser in dig-urn.mjs.
 *
 * Before unification there were two divergent parseURN copies (dig-urn.mjs and an
 * inlined one in background.js). These tests pin the SUPERSET behaviour the single
 * shared implementation must satisfy so callers on both the Node (server.js) and the
 * module-SW (background.js) side keep working byte-for-byte:
 *   - strips a leading `chia://` scheme (background.js needed this)
 *   - strips leading slashes (dig-urn.mjs needed this)
 *   - strips the `urn:dig:` prefix
 *   - extracts an optional `?salt=<hex>` query param (background.js needed this)
 *   - lowercases storeId / roothash, defaults chain to `chia`
 *
 * Run: node --test tests/
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { parseURN } from '@/lib/dig-urn';

const STORE = 'a'.repeat(64);
const ROOT = 'b'.repeat(64);

test('full urn with chain, root and resource key', () => {
  assert.deepEqual(parseURN(`urn:dig:chia:${STORE}:${ROOT}/index.html`), {
    chain: 'chia', storeId: STORE, roothash: ROOT, resourceKey: 'index.html', salt: null,
  });
});

test('urn without roothash defaults roothash to null', () => {
  assert.deepEqual(parseURN(`urn:dig:chia:${STORE}/a.css`), {
    chain: 'chia', storeId: STORE, roothash: null, resourceKey: 'a.css', salt: null,
  });
});

test('bare storeId (no chain prefix) assumes chia', () => {
  assert.deepEqual(parseURN(`${STORE}/x.js`), {
    chain: 'chia', storeId: STORE, roothash: null, resourceKey: 'x.js', salt: null,
  });
});

// #686 canonical user-facing content link: chia://<storeId>:<root>[/resource].
// After the chia:// strip the parser sees `<64hex-storeId>:<64hex-root>`; the LEADING
// 64-hex segment is the storeId, NOT a chain label (a chain label is a short alnum like
// `chia`, never 64-hex). Regression guard for the swap bug (super-repo #741).
test('#686 bare rooted content link: leading 64-hex is the storeId, not a chain', () => {
  assert.deepEqual(parseURN(`chia://${STORE}:${ROOT}`), {
    chain: 'chia', storeId: STORE, roothash: ROOT, resourceKey: '', salt: null,
  });
});

test('#686 bare rooted content link with a nested resource path', () => {
  assert.deepEqual(parseURN(`chia://${STORE}:${ROOT}/path/x.png`), {
    chain: 'chia', storeId: STORE, roothash: ROOT, resourceKey: 'path/x.png', salt: null,
  });
});

test('bare rooted content link without the chia:// scheme still parses', () => {
  assert.deepEqual(parseURN(`${STORE}:${ROOT}/index.html`), {
    chain: 'chia', storeId: STORE, roothash: ROOT, resourceKey: 'index.html', salt: null,
  });
});

// The chain-prefixed form store-refs.ts emits (`chia://chia:<storeId>:<root>/res`) must
// keep resolving with chain=chia — the fix must not regress it.
test('chain-prefixed rooted form (chia:<storeId>:<root>) still parses with chain=chia', () => {
  assert.deepEqual(parseURN(`chia://chia:${STORE}:${ROOT}/style.css`), {
    chain: 'chia', storeId: STORE, roothash: ROOT, resourceKey: 'style.css', salt: null,
  });
});

test('strips a chia:// scheme prefix (background.js behaviour)', () => {
  assert.deepEqual(parseURN(`chia://urn:dig:chia:${STORE}/p.png`), {
    chain: 'chia', storeId: STORE, roothash: null, resourceKey: 'p.png', salt: null,
  });
});

test('strips leading slashes (dig-urn.mjs behaviour)', () => {
  assert.deepEqual(parseURN(`/urn:dig:chia:${STORE}/p.png`), {
    chain: 'chia', storeId: STORE, roothash: null, resourceKey: 'p.png', salt: null,
  });
});

test('extracts ?salt=<hex> and strips it from the path (background.js behaviour)', () => {
  assert.deepEqual(parseURN(`urn:dig:chia:${STORE}/secret.txt?salt=deadBEEF`), {
    chain: 'chia', storeId: STORE, roothash: null, resourceKey: 'secret.txt', salt: 'deadbeef',
  });
});

test('uppercase hex is lowercased', () => {
  const p = parseURN(`urn:dig:chia:${STORE.toUpperCase()}`)!;
  assert.equal(p.storeId, STORE);
  assert.equal(p.chain, 'chia');
});

test('empty resourceKey when none present', () => {
  assert.equal(parseURN(`urn:dig:chia:${STORE}`)!.resourceKey, '');
});

test('invalid input returns null', () => {
  assert.equal(parseURN(''), null);
  assert.equal(parseURN(null as unknown as string), null);
  assert.equal(parseURN('not-a-urn'), null);
  assert.equal(parseURN('urn:dig:chia:tooshort/x'), null);
});
