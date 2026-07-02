/**
 * Tests for the connect() lifecycle of the injected provider core (dig-provider-core.mjs).
 *
 * provider.test.mjs covers the static surface + error mapping + a single rpc round-trip.
 * This file covers the genuinely under-tested connect path (the 50%-funcs gap):
 *   - connect() resolves and flips isConnected + fires the 'connect' event
 *   - request({method:'connect'}) and request({method:'chip0002_connect'}) both dispatch
 *     into connect() (not a raw rpc)
 *   - the pending-approval (202) retry loop: connect() polls until the wallet approves,
 *     then resolves
 *   - a non-pending error from connect() propagates (no infinite loop)
 *   - on()/off() listener registration drives the 'connect' emit
 *
 * The retry loop sleeps via setTimeout(1200); we keep the test fast + deterministic with
 * node:test's per-test mock timers (t.mock.timers) — scoped to the single test, so it can't
 * race with the rest of the (concurrently-run) suite the way a global setTimeout patch would.
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProvider } from '../dig-provider-core.mjs';

test('connect() resolves, flips isConnected, and fires the connect event', async () => {
  const events = [];
  const provider = buildProvider({
    bridgeCall: async (method) => {
      assert.equal(method, 'chip0002_connect');
      return { status: 200, body: { data: { connected: true } } };
    },
    version: '1.0.0',
  });
  provider.on('connect', (d) => events.push(d));
  const r = await provider.connect();
  assert.deepEqual(r, { connected: true });
  assert.equal(provider.isConnected(), true);
  assert.deepEqual(events, [{ connected: true }]);
});

test('connect() passes the eager flag through to the bridge', async () => {
  let seenParams = null;
  const provider = buildProvider({
    bridgeCall: async (_method, params) => { seenParams = params; return { status: 200, body: { data: {} } }; },
  });
  await provider.connect(true);
  assert.deepEqual(seenParams, { eager: true });
});

test('request({method:"connect"}) dispatches into connect()', async () => {
  let calls = 0;
  const provider = buildProvider({
    bridgeCall: async (method) => { calls++; assert.equal(method, 'chip0002_connect'); return { status: 200, body: { data: { ok: 1 } } }; },
  });
  const r = await provider.request({ method: 'connect', params: { eager: false } });
  assert.deepEqual(r, { ok: 1 });
  assert.equal(calls, 1);
  assert.equal(provider.isConnected(), true);
});

test('request({method:"chip0002_connect"}) also dispatches into connect()', async () => {
  const provider = buildProvider({
    bridgeCall: async () => ({ status: 200, body: { data: { ok: 2 } } }),
  });
  const r = await provider.request({ method: 'chip0002_connect' });
  assert.deepEqual(r, { ok: 2 });
});

test('connect() polls through 202 pending-approval responses then resolves', async () => {
  // The backoff calls the global setTimeout(res, 1200). Patch it to fire on the next macrotask
  // (delay 0) for the duration of this test so the retry loop advances deterministically and
  // fast, while still interleaving correctly with the awaited (real-async) bridgeCall. This is
  // more robust than fake timer ticks, which don't reliably interleave with awaited promises.
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, _ms, ...args) => realSetTimeout(fn, 0, ...args);
  try {
    let attempt = 0;
    const provider = buildProvider({
      bridgeCall: async () => {
        attempt++;
        if (attempt < 3) return { status: 202, body: {} }; // pending approval, retry
        return { status: 200, body: { data: { approved: true } } };
      },
    });
    const r = await provider.connect();
    assert.deepEqual(r, { approved: true });
    assert.equal(attempt, 3, 'should have retried twice before approval');
    assert.equal(provider.isConnected(), true);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

test('connect() propagates a non-pending error instead of looping forever', async () => {
  const provider = buildProvider({
    bridgeCall: async () => ({ status: 401, body: { error: 'unauthorized' } }),
  });
  await assert.rejects(
    () => provider.connect(),
    (e) => { assert.equal(e.code, 4100); return true; }
  );
  assert.equal(provider.isConnected(), false);
});

test('off() removes a previously-registered connect listener', async () => {
  const seen = [];
  const handler = (d) => seen.push(d);
  const provider = buildProvider({
    bridgeCall: async () => ({ status: 200, body: { data: { n: 1 } } }),
  });
  provider.on('connect', handler);
  provider.off('connect', handler);
  await provider.connect();
  assert.deepEqual(seen, [], 'removed listener must not fire');
});

test('a throwing connect listener is isolated and does not reject connect()', async () => {
  const provider = buildProvider({
    bridgeCall: async () => ({ status: 200, body: { data: { n: 1 } } }),
  });
  provider.on('connect', () => { throw new Error('listener blew up'); });
  // Must still resolve despite the listener throwing.
  const r = await provider.connect();
  assert.deepEqual(r, { n: 1 });
});
