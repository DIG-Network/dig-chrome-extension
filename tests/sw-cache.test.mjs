/**
 * Unit tests for the pure SW-authoritative wallet read cache (sw-cache.mjs): deterministic keys,
 * bounded LRU eviction, TTL expiry, and epoch-based (mutation-driven) invalidation.
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { WalletCache, cacheKey, stableStringify } from '../sw-cache.mjs';

test('cacheKey is stable across param key ordering', () => {
  assert.equal(
    cacheKey('walletRead', { b: 2, a: 1 }),
    cacheKey('walletRead', { a: 1, b: 2 }),
  );
  assert.notEqual(cacheKey('walletRead', { a: 1 }), cacheKey('walletRead', { a: 2 }));
  assert.notEqual(cacheKey('getBalances', { a: 1 }), cacheKey('getActivity', { a: 1 }));
});

test('stableStringify sorts nested keys and preserves array order', () => {
  assert.equal(stableStringify({ z: { y: 1, x: 2 }, a: [3, 1, 2] }), '{"a":[3,1,2],"z":{"x":2,"y":1}}');
  assert.equal(stableStringify(undefined), 'null');
  assert.equal(stableStringify(null), 'null');
  assert.equal(stableStringify('s'), '"s"');
});

test('get returns a stored value and refreshes LRU recency', () => {
  const c = new WalletCache({ max: 2 });
  c.set('a', 1, { tag: 't' });
  c.set('b', 2, { tag: 't' });
  assert.equal(c.get('a'), 1); // touch a → a is now MRU
  c.set('c', 3, { tag: 't' }); // over capacity → evict LRU (b)
  assert.equal(c.get('b'), undefined);
  assert.equal(c.get('a'), 1);
  assert.equal(c.get('c'), 3);
});

test('a miss returns undefined', () => {
  const c = new WalletCache();
  assert.equal(c.get('nope'), undefined);
});

test('TTL expiry makes an entry a miss', () => {
  let t = 1000;
  const c = new WalletCache({ now: () => t });
  c.set('k', 'v', { tag: 'x', ttlMs: 100 });
  assert.equal(c.get('k'), 'v');
  t = 1101; // past ttl
  assert.equal(c.get('k'), undefined);
});

test('ttlMs=0 means no expiry', () => {
  let t = 0;
  const c = new WalletCache({ now: () => t });
  c.set('k', 'v', { tag: 'x', ttlMs: 0 });
  t = 1e9;
  assert.equal(c.get('k'), 'v');
});

test('bumpEpoch invalidates entries tagged with that tag only', () => {
  const c = new WalletCache();
  c.set('bal', { xch: 1 }, { tag: 'Balances' });
  c.set('act', [1, 2], { tag: 'Activity' });
  assert.equal(c.epochOf('Balances'), 0);
  const next = c.bumpEpoch('Balances');
  assert.equal(next, 1);
  assert.equal(c.get('bal'), undefined, 'Balances entry invalidated');
  assert.deepEqual(c.get('act'), [1, 2], 'Activity entry untouched');
});

test('a new write after a bump is cached under the new epoch and survives', () => {
  const c = new WalletCache();
  c.set('bal', 1, { tag: 'Balances' });
  c.bumpEpoch('Balances');
  c.set('bal', 2, { tag: 'Balances' });
  assert.equal(c.get('bal'), 2);
});

test('clear drops entries but preserves epochs', () => {
  const c = new WalletCache();
  c.bumpEpoch('Balances');
  c.set('bal', 1, { tag: 'Balances' });
  c.clear();
  assert.equal(c.size, 0);
  assert.equal(c.epochOf('Balances'), 1);
});

test('max is coerced to at least 1', () => {
  const c = new WalletCache({ max: 0 });
  c.set('a', 1);
  c.set('b', 2);
  assert.equal(c.size, 1);
});
