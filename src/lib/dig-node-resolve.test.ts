/**
 * Tests for the dig-node resolution order + reachability detection (server-config.mjs).
 *
 * The local dig-node is reachable at TWO addresses:
 *   1. bare `http://dig.local` (port 80, branded — written by the installer's hosts entry)
 *   2. `http://localhost:<port>` (default 9778, the canonical dig-node control port, #132 —
 *      the always-on fallback)
 *
 * Resolution MUST PREFER `http://dig.local` (no port) and fall back to `http://localhost:<port>`.
 * This is forward-compatible: until the installer writes the hosts entry, dig.local simply
 * fails to connect and localhost is used. The functions take an injectable `fetch` so the
 * order + detection are unit-testable under `node --test` without a real socket.
 *
 * Run: node --test tests/
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  DIG_LOCAL_URL,
  DEFAULT_DIG_NODE_PORT,
  digNodeCandidates,
  probeDigNode,
  resolveDigNode,
} from '@/lib/server-config';

test('DIG_LOCAL_URL is the bare branded http://dig.local (no port)', () => {
  assert.equal(DIG_LOCAL_URL, 'http://dig.local');
});

test('digNodeCandidates prefers dig.local, then falls back to localhost:port', () => {
  // Nothing configured → default port 9778 (the canonical dig-node control port, #132).
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

test('digNodeCandidates treats 127.0.0.1 as a local alias (still uses the dig.local ladder)', () => {
  assert.deepEqual(digNodeCandidates('127.0.0.1:9777'), [
    'http://dig.local',
    'http://localhost:9777',
  ]);
});

test('digNodeCandidates uses the default port when a local-alias host has none', () => {
  assert.deepEqual(digNodeCandidates('localhost'), [
    'http://dig.local',
    `http://localhost:${DEFAULT_DIG_NODE_PORT}`,
  ]);
});

test('digNodeCandidates always lists dig.local FIRST, localhost SECOND (default/local-alias hosts)', () => {
  const list = digNodeCandidates('localhost:8080');
  assert.equal(list[0], 'http://dig.local', 'dig.local must be tried first');
  assert.ok(list[1].startsWith('http://localhost:'), 'localhost must be the fallback');
  assert.equal(list.length, 2);
});

// ---- §5.3 override precedence: an explicit custom node host wins ENTIRELY -----------------
//
// REGRESSION (#43 / #41 audit): `digNodeCandidates` used to destructure only `{ port }` from
// the parsed host and silently drop `url`, so a user who configured a genuinely different
// node (e.g. `my-node.example.com:9000`) never actually had it tried — the extension always
// probed `dig.local` then `localhost:<port>` instead, ignoring the configured host entirely.
// The options page promises "Point this at the dig-node's address", so this was a real bug.

test('digNodeCandidates: an explicit custom host wins ENTIRELY over dig.local/localhost (regression)', () => {
  const list = digNodeCandidates('my-node.example.com:9000');
  assert.deepEqual(
    list,
    ['http://my-node.example.com:9000'],
    'the configured custom host must be the ONLY candidate — dig.local/localhost must not be probed'
  );
});

test('digNodeCandidates: a custom host with no port falls back to the default dig-node port', () => {
  assert.deepEqual(digNodeCandidates('192.168.1.50'), [`http://192.168.1.50:${DEFAULT_DIG_NODE_PORT}`]);
});

test('digNodeCandidates: a custom host is case-insensitively distinguished from local aliases', () => {
  // "DIG.LOCAL" / "LOCALHOST" typed in any case are still the well-known local aliases, not a
  // custom remote node — they keep the normal ladder.
  assert.deepEqual(digNodeCandidates('LOCALHOST:9000'), ['http://dig.local', 'http://localhost:9000']);
});

test('probeDigNode resolves true when fetch succeeds within the timeout', async () => {
  const okFetch = async () => ({ ok: true });
  assert.equal(await probeDigNode('http://dig.local', { fetch: okFetch as unknown as typeof globalThis.fetch }), true);
});

test('probeDigNode resolves false when fetch rejects (host unreachable)', async () => {
  const failFetch = async () => { throw new Error('Failed to fetch'); };
  assert.equal(await probeDigNode('http://dig.local', { fetch: failFetch as unknown as typeof globalThis.fetch }), false);
});

test('probeDigNode treats a no-cors opaque response (status 0) as reachable', async () => {
  // no-cors GETs come back opaque (ok=false, status=0) yet the socket WAS reachable.
  const opaqueFetch = async () => ({ ok: false, status: 0, type: 'opaque' });
  assert.equal(await probeDigNode('http://localhost:8080', { fetch: opaqueFetch as unknown as typeof globalThis.fetch }), true);
});

test('resolveDigNode returns dig.local when it is reachable (preferred)', async () => {
  const tried: string[] = [];
  const fetch = async (url: string) => { tried.push(url); return { ok: true }; };
  const r = await resolveDigNode('localhost:8080', { fetch: fetch as unknown as typeof globalThis.fetch });
  assert.equal(r, 'http://dig.local');
  // It must have probed dig.local first and short-circuited (not probe localhost).
  assert.deepEqual(tried, ['http://dig.local/']);
});

test('resolveDigNode falls back to localhost:port when dig.local is unreachable', async () => {
  const tried: string[] = [];
  const fetch = async (url: string) => {
    tried.push(url);
    if (url.includes('dig.local')) throw new Error('ENOTFOUND dig.local');
    return { ok: true };
  };
  const r = await resolveDigNode('localhost:8080', { fetch: fetch as unknown as typeof globalThis.fetch });
  assert.equal(r, 'http://localhost:8080');
  assert.deepEqual(tried, ['http://dig.local/', 'http://localhost:8080/']);
});

test('resolveDigNode returns null when NO candidate is reachable (dig-node not running)', async () => {
  const fetch = async () => { throw new Error('Failed to fetch'); };
  const r = await resolveDigNode('localhost:8080', { fetch: fetch as unknown as typeof globalThis.fetch });
  assert.equal(r, null);
});

test('resolveDigNode probes ONLY the custom host when one is explicitly configured (regression)', async () => {
  const tried: string[] = [];
  const fetch = async (url: string) => { tried.push(url); return { ok: true }; };
  const r = await resolveDigNode('my-node.example.com:9000', { fetch: fetch as unknown as typeof globalThis.fetch });
  assert.equal(r, 'http://my-node.example.com:9000');
  // Must NOT have probed dig.local or localhost — the custom host wins entirely (§5.3).
  assert.deepEqual(tried, ['http://my-node.example.com:9000/']);
});
