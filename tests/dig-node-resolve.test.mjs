/**
 * Tests for the dig-node resolution order + reachability detection (server-config.mjs).
 *
 * The local dig-node is reachable at TWO addresses:
 *   1. bare `http://dig.local` (port 80, branded — written by the installer's hosts entry)
 *   2. `http://localhost:<port>` (default 8080, the always-on fallback)
 *
 * Resolution MUST PREFER `http://dig.local` (no port) and fall back to `http://localhost:<port>`.
 * This is forward-compatible: until the installer writes the hosts entry, dig.local simply
 * fails to connect and localhost is used. The functions take an injectable `fetch` so the
 * order + detection are unit-testable under `node --test` without a real socket.
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DIG_LOCAL_URL,
  DEFAULT_DIG_NODE_PORT,
  digNodeCandidates,
  probeDigNode,
  resolveDigNode,
} from '../server-config.mjs';

test('DIG_LOCAL_URL is the bare branded http://dig.local (no port)', () => {
  assert.equal(DIG_LOCAL_URL, 'http://dig.local');
});

test('digNodeCandidates prefers dig.local, then falls back to localhost:port', () => {
  // Nothing configured → default port 8080.
  assert.deepEqual(digNodeCandidates(), [
    'http://dig.local',
    `http://localhost:${DEFAULT_DIG_NODE_PORT}`,
  ]);
});

test('digNodeCandidates honours a configured host:port for the localhost fallback', () => {
  assert.deepEqual(digNodeCandidates('localhost:9777'), [
    'http://dig.local',
    'http://localhost:9777',
  ]);
});

test('digNodeCandidates uses the default port when the configured host has none', () => {
  assert.deepEqual(digNodeCandidates('my-node'), [
    'http://dig.local',
    `http://localhost:${DEFAULT_DIG_NODE_PORT}`,
  ]);
});

test('digNodeCandidates always lists dig.local FIRST, localhost SECOND', () => {
  const list = digNodeCandidates('localhost:8080');
  assert.equal(list[0], 'http://dig.local', 'dig.local must be tried first');
  assert.ok(list[1].startsWith('http://localhost:'), 'localhost must be the fallback');
  assert.equal(list.length, 2);
});

test('probeDigNode resolves true when fetch succeeds within the timeout', async () => {
  const okFetch = async () => ({ ok: true });
  assert.equal(await probeDigNode('http://dig.local', { fetch: okFetch }), true);
});

test('probeDigNode resolves false when fetch rejects (host unreachable)', async () => {
  const failFetch = async () => { throw new Error('Failed to fetch'); };
  assert.equal(await probeDigNode('http://dig.local', { fetch: failFetch }), false);
});

test('probeDigNode treats a no-cors opaque response (status 0) as reachable', async () => {
  // no-cors GETs come back opaque (ok=false, status=0) yet the socket WAS reachable.
  const opaqueFetch = async () => ({ ok: false, status: 0, type: 'opaque' });
  assert.equal(await probeDigNode('http://localhost:8080', { fetch: opaqueFetch }), true);
});

test('resolveDigNode returns dig.local when it is reachable (preferred)', async () => {
  const tried = [];
  const fetch = async (url) => { tried.push(url); return { ok: true }; };
  const r = await resolveDigNode('localhost:8080', { fetch });
  assert.equal(r, 'http://dig.local');
  // It must have probed dig.local first and short-circuited (not probe localhost).
  assert.deepEqual(tried, ['http://dig.local/']);
});

test('resolveDigNode falls back to localhost:port when dig.local is unreachable', async () => {
  const tried = [];
  const fetch = async (url) => {
    tried.push(url);
    if (url.includes('dig.local')) throw new Error('ENOTFOUND dig.local');
    return { ok: true };
  };
  const r = await resolveDigNode('localhost:8080', { fetch });
  assert.equal(r, 'http://localhost:8080');
  assert.deepEqual(tried, ['http://dig.local/', 'http://localhost:8080/']);
});

test('resolveDigNode returns null when NO candidate is reachable (dig-node not running)', async () => {
  const fetch = async () => { throw new Error('Failed to fetch'); };
  const r = await resolveDigNode('localhost:8080', { fetch });
  assert.equal(r, null);
});
