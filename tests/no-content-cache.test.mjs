/**
 * The extension MUST NOT cache resolved/decrypted content (#43 / #41 SoC audit, decision 3:
 * "chrome://settings/dig cache: REMOVE. No node config in browser chrome; cache + node
 * management live on the node's own control surface"). Caching is a dig-node job — the
 * extension is a pure RPC consumer that re-verifies and re-decrypts on every read.
 *
 * This pins the ABSENCE of every content-cache mechanism found in the audit + this task's own
 * follow-on investigation:
 *   - background.js: the session-only in-memory `resourceCache` Map (the audit's literal
 *     finding) + its `getCacheStats`/`clearCache` message handlers + `preloadResources`
 *     cache-warming.
 *   - middleware.js: the content-script `MemoryCache` + `IndexedDBCache` classes (a PERSISTENT,
 *     24-hour, on-disk cache — found during this task, a more severe instance of the same
 *     violation than the audit's literal line refs).
 *   - content.js: writes into either of the above caches, and the page-preload pass that only
 *     existed to warm them.
 *   - options.html / src/entries/options.ts: the "Local content cache" usage/clear UI.
 *   - messages.mjs: the `getCacheStats` / `clearCache` / `preloadResources` catalogued actions.
 *
 * The client-side verify+decrypt path (the shared `dig_client` wasm — retrievalKey/deriveKey/
 * verifyInclusion/decryptChunk) is the trustless read tier and MUST remain; this suite asserts
 * absence of CACHING only, not of the crypto pipeline.
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ACTIONS, MESSAGE_CATALOGUE } from '../messages.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(ROOT, f), 'utf8');

test('background.js has no in-memory resource/content cache', () => {
  const src = read('background.js');
  assert.ok(!/resourceCache/.test(src), 'background.js must not define/use a resourceCache');
  assert.ok(!/getCacheStats|clearCache/.test(src), 'background.js must not handle cache-stat/clear actions');
});

test('background.js does not warm a cache via preloadResources', () => {
  const src = read('background.js');
  assert.ok(!/preloadResources/.test(src), 'background.js must not implement cache-warming preload');
});

test('middleware.js has no MemoryCache / IndexedDBCache content-caching classes', () => {
  const src = read('middleware.js');
  assert.ok(!/class MemoryCache/.test(src), 'middleware.js must not define a MemoryCache class');
  assert.ok(!/class IndexedDBCache/.test(src), 'middleware.js must not define an IndexedDBCache class');
  assert.ok(!/indexedDB\.open/.test(src), 'middleware.js must not open a persistent IndexedDB content cache');
});

test('content.js never writes resolved content into a memory/IndexedDB cache', () => {
  const src = read('content.js');
  assert.ok(!/memoryCache\.set|indexedDBCache\.set/.test(src), 'content.js must not cache resolved content');
  assert.ok(!/preloadPageResources/.test(src), 'content.js must not run the (now-pointless) cache-warming preload pass');
});

test('options.html has no "Local content cache" section or cache testids', () => {
  const html = read('options.html');
  assert.ok(!/cache-stat|clear-cache/.test(html), 'options.html must not expose cache stat/clear controls');
  assert.ok(!/Local content cache/i.test(html), 'options.html must not describe a local content cache');
});

test('src/entries/options.ts has no cache stat/clear handlers', () => {
  const src = read('src/entries/options.ts');
  assert.ok(!/getCacheStats|clearCache|refreshCache/.test(src), 'the options entry must not manage a content cache');
});

test('messages.mjs catalogues no cache-related actions', () => {
  // Check the actual runtime catalogue (not raw source text) so an explanatory code comment
  // documenting the removal (e.g. in a changelog-style doc comment) can't false-positive this.
  for (const removed of ['getCacheStats', 'clearCache', 'preloadResources']) {
    assert.ok(!(removed in ACTIONS), `ACTIONS must no longer catalogue "${removed}"`);
    assert.ok(!(removed in MESSAGE_CATALOGUE), `MESSAGE_CATALOGUE must no longer document "${removed}"`);
  }
});

test('the client-side verify+decrypt trustless-read path is UNCHANGED (not removed by this fix)', () => {
  const src = read('background.js');
  assert.match(src, /verifyInclusion/, 'client-side merkle verification must remain');
  assert.match(src, /decryptChunk/, 'client-side decryption must remain');
  assert.match(src, /dig_client\.js/, 'the shared dig_client wasm must still be the crypto source');
});
