/**
 * Tests for the dig-node resolution order + reachability detection (server-config.mjs).
 *
 * The local dig-node is reachable at TWO addresses:
 *   1. bare `http://dig.local` (port 80, branded — written by the installer's hosts entry)
 *   2. `http://127.0.0.1:<port>` (default 9778, the canonical dig-node control port, #132 —
 *      the always-on fallback)
 *
 * Resolution MUST PREFER `http://dig.local` (no port) and fall back to `http://127.0.0.1:<port>`.
 * This is forward-compatible: until the installer writes the hosts entry, dig.local simply
 * fails to connect and 127.0.0.1 is used. The functions take an injectable `fetch` so the
 * order + detection are unit-testable under `node --test` without a real socket.
 *
 * The fallback is the EXPLICIT IPv4 literal `127.0.0.1`, never the bare word `localhost` (#287):
 * on Windows `localhost` resolves to `::1` (IPv6) FIRST, but the dig-node binds IPv4 only, so a
 * `localhost` fetch hit a closed `[::1]:<port>` and reported the node offline while it was
 * running. This holds regardless of which local alias the user typed (`localhost`, `127.0.0.1`,
 * `::1`, or nothing) — the ladder's SECOND rung is always the literal `127.0.0.1`.
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

test('digNodeCandidates prefers dig.local, then falls back to 127.0.0.1:port (#287)', () => {
  // Nothing configured → default port 9778 (the canonical dig-node control port, #132).
  assert.deepEqual(digNodeCandidates(), [
    'http://dig.local',
    `http://127.0.0.1:${DEFAULT_DIG_NODE_PORT}`,
  ]);
});

test('digNodeCandidates honours a configured host:port for the IPv4 fallback', () => {
  assert.deepEqual(digNodeCandidates('localhost:9777'), [
    'http://dig.local',
    'http://127.0.0.1:9777',
  ]);
});

test('digNodeCandidates: typing 127.0.0.1 explicitly is honoured verbatim, not collapsed (#287 regression)', () => {
  // REGRESSION (#287 bug 2): the ladder fallback used to be the hardcoded literal `localhost`
  // regardless of which local alias was configured — so a user who typed `127.0.0.1` to force
  // IPv4 got silently rewritten back to `localhost` (and, on Windows, right back to the ::1
  // mismatch this whole ladder exists to avoid). Now the fallback is always the explicit IPv4
  // literal, so this is a no-op rewrite (127.0.0.1 in, 127.0.0.1 out) rather than a collapse.
  assert.deepEqual(digNodeCandidates('127.0.0.1:9777'), [
    'http://dig.local',
    'http://127.0.0.1:9777',
  ]);
});

test('digNodeCandidates uses the default port when a local-alias host has none', () => {
  assert.deepEqual(digNodeCandidates('localhost'), [
    'http://dig.local',
    `http://127.0.0.1:${DEFAULT_DIG_NODE_PORT}`,
  ]);
});

test('digNodeCandidates always lists dig.local FIRST, 127.0.0.1 SECOND (default/local-alias hosts)', () => {
  const list = digNodeCandidates('localhost:8080');
  assert.equal(list[0], 'http://dig.local', 'dig.local must be tried first');
  assert.ok(list[1].startsWith('http://127.0.0.1:'), '127.0.0.1 (explicit IPv4) must be the fallback');
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
  assert.deepEqual(digNodeCandidates('LOCALHOST:9000'), ['http://dig.local', 'http://127.0.0.1:9000']);
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

test('resolveDigNode falls back to 127.0.0.1:port when dig.local is unreachable (#287)', async () => {
  const tried: string[] = [];
  const fetch = async (url: string) => {
    tried.push(url);
    if (url.includes('dig.local')) throw new Error('ENOTFOUND dig.local');
    return { ok: true };
  };
  const r = await resolveDigNode('localhost:8080', { fetch: fetch as unknown as typeof globalThis.fetch });
  assert.equal(r, 'http://127.0.0.1:8080');
  assert.deepEqual(tried, ['http://dig.local/', 'http://127.0.0.1:8080/']);
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
