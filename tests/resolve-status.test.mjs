/**
 * Pure tests for the Resolver tab's node-status view-model (resolve-status.mjs).
 *
 * These pin the §5.3 client→node ladder verdict (custom > dig.local > localhost > rpc.dig.net)
 * as a display label, so the Resolver tab's "Resolving via" line can never drift from the
 * resolution contract. The popup renderer is thin glue over these tested pure functions.
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HOSTED_GATEWAY,
  RESOLVE_TIERS,
  isCustomHost,
  resolveViaStatus,
} from '../resolve-status.mjs';

test('RESOLVE_TIERS is the §5.3 order, custom first, hosted last', () => {
  assert.deepEqual([...RESOLVE_TIERS], ['custom', 'dig.local', 'localhost', 'rpc.dig.net']);
  assert.equal(HOSTED_GATEWAY, 'rpc.dig.net');
});

test('isCustomHost recognises genuine overrides, not local aliases', () => {
  assert.equal(isCustomHost('my-node.example.com:9000'), true);
  assert.equal(isCustomHost('http://node.local-lan:8080'), true);
  for (const local of ['', 'localhost', 'localhost:8080', '127.0.0.1', 'dig.local', 'http://dig.local', '::1']) {
    assert.equal(isCustomHost(local), false, `${local} should not be a custom host`);
  }
});

test('resolveViaStatus names dig.local when the branded local node answered', () => {
  const vm = resolveViaStatus({ reachable: true, base: 'http://dig.local' });
  assert.equal(vm.tier, 'dig.local');
  assert.match(vm.label, /dig\.local/);
  assert.equal(vm.endpoint, 'http://dig.local');
});

test('resolveViaStatus names localhost (with port) when the loopback node answered', () => {
  const vm = resolveViaStatus({ reachable: true, base: 'http://localhost:8080' });
  assert.equal(vm.tier, 'localhost');
  assert.match(vm.label, /localhost:8080/);
  assert.equal(vm.endpoint, 'http://localhost:8080');
});

test('resolveViaStatus names a reachable non-alias host as the custom override (§5.3 tier 1)', () => {
  const vm = resolveViaStatus({ reachable: true, base: 'http://my-node.example.com:9000' });
  assert.equal(vm.tier, 'custom');
  assert.match(vm.label, /my-node\.example\.com:9000/);
});

test('resolveViaStatus falls back to the hosted gateway when no local node is reachable', () => {
  const vm = resolveViaStatus({ reachable: false, base: null });
  assert.equal(vm.tier, 'rpc.dig.net');
  assert.match(vm.label, /rpc\.dig\.net/);
  assert.equal(vm.endpoint, 'https://rpc.dig.net');
});

test('resolveViaStatus says a configured custom node is unreachable when the probe failed', () => {
  const vm = resolveViaStatus({ reachable: false }, { customHost: 'my-node.example.com:9000' });
  assert.equal(vm.tier, 'rpc.dig.net');
  assert.match(vm.label, /custom node unreachable/i);
});

test('resolveViaStatus tolerates a missing/empty status argument', () => {
  const vm = resolveViaStatus();
  assert.equal(vm.tier, 'rpc.dig.net');
  assert.equal(vm.endpoint, 'https://rpc.dig.net');
});
