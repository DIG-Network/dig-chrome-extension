/**
 * Tests for the DIG Control Panel decision logic (dig-control.mjs).
 *
 * The Control Panel mirrors the native DIG Browser's dig://control surface and the dig-node
 * control RPC contract (modules/dig-companion/src/{control,meta}.rs — the source of truth):
 *
 *   - A LOCAL dig-node is reachable (dig.local → localhost:<port>) → show the node-management
 *     surface keyed on the control.* RPCs (control.status / control.config.* / control.cache.* /
 *     control.hostedStores.* / control.sync.*).
 *   - NO local dig-node → a landing page that encourages downloading + installing the dig-node
 *     (link to the universal installer); the read path transparently FALLS BACK to rpc.dig.net.
 *
 * Honest-status constraint (CLAUDE.md): the mutating control.* methods are loopback-only AND
 * gated by a local control token read from `<config_dir>/control-token`. A browser extension
 * has no filesystem access, so it CANNOT present the token — the dig-node answers control.* with
 * UNAUTHORIZED (-32030). The extension therefore drives only OPEN methods to show read-only node
 * status, and deep-links full management to the native DIG Browser (which CAN present the token).
 * These tests pin the catalogued method names, the fallback target, the manage-vs-install branch,
 * and the UNAUTHORIZED→manage-in-browser classification — byte-consistent with the node.
 *
 * Functions take an injectable node resolver / fetch so the branch is unit-testable under
 * `node --test` with no real socket.
 *
 * Run: node --test tests/
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  CONTROL_METHODS,
  CONTROL_TOKEN_HEADER,
  CONTROL_ERR,
  HOSTED_RPC_FALLBACK,
  decideControlView,
  controlInstallPrompt,
  controlPanelViewModel,
  isControlMethod,
  isUnauthorizedControlResult,
} from '@/lib/dig-control';

// ---- Catalogued control.* method surface (must match dig-node control.rs / meta.rs) ----

test('CONTROL_METHODS catalogues EXACTLY the dig-node control surface (byte-consistent)', () => {
  // The control methods served by dig-node/crates/dig-node-service/src/control.rs dispatch_control()
  // (source of truth after #209 moved the node out of dig-companion). Includes the subscription +
  // peer-status surface added on the node.
  assert.deepEqual([...CONTROL_METHODS].sort(), [
    'control.cache.clear',
    'control.cache.get',
    'control.cache.setCap',
    'control.config.get',
    'control.config.setUpstream',
    'control.hostedStores.list',
    'control.hostedStores.pin',
    'control.hostedStores.status',
    'control.hostedStores.unpin',
    'control.listSubscriptions',
    'control.peerStatus',
    'control.status',
    'control.subscribe',
    'control.sync.status',
    'control.sync.trigger',
    'control.unsubscribe',
  ]);
});

test('CONTROL_METHODS are all in the control.* namespace (distinct from the dig.* read methods)', () => {
  for (const m of CONTROL_METHODS) {
    assert.match(m, /^control\./, `${m} must be a control.* method`);
  }
});

test('CONTROL_TOKEN_HEADER matches the dig-node header name (X-Dig-Control-Token)', () => {
  // The dig-node gates control.* behind this header (or params._control_token).
  assert.equal(CONTROL_TOKEN_HEADER, 'X-Dig-Control-Token');
});

test('CONTROL_ERR mirrors the dig-node control error codes (meta.rs ErrorCode)', () => {
  // dig-node/crates/dig-node-service/src/meta.rs ErrorCode (source of truth, #209).
  assert.equal(CONTROL_ERR.UNAUTHORIZED, -32030);
  assert.equal(CONTROL_ERR.NOT_SUPPORTED, -32031);
  assert.equal(CONTROL_ERR.CONTROL_ERROR, -32032);
});

test('isControlMethod recognises catalogued control methods and rejects read methods', () => {
  assert.equal(isControlMethod('control.status'), true);
  assert.equal(isControlMethod('control.cache.clear'), true);
  // Any control.* namespace member is a control method (matches the node's prefix gate).
  assert.equal(isControlMethod('control.future.method'), true);
  // The dig.* / cache.* read methods are NOT control methods (open, no token).
  assert.equal(isControlMethod('dig.getContent'), false);
  assert.equal(isControlMethod('cache.getConfig'), false);
  assert.equal(isControlMethod('rpc.discover'), false);
  assert.equal(isControlMethod(''), false);
  assert.equal(isControlMethod(null), false);
});

// ---- UNAUTHORIZED classification (the MV3 honest-status path) ----

test('isUnauthorizedControlResult detects the dig-node UNAUTHORIZED error envelope', () => {
  // The dig-node answers control.* without a token with code -32030 (meta.rs ErrorCode::Unauthorized).
  assert.equal(isUnauthorizedControlResult({ error: { code: -32030 } }), true);
  assert.equal(isUnauthorizedControlResult({ error: { code: -32030, data: { code: 'UNAUTHORIZED' } } }), true);
  // A successful result, or any other error, is NOT an authorization failure.
  assert.equal(isUnauthorizedControlResult({ result: { running: true } }), false);
  assert.equal(isUnauthorizedControlResult({ error: { code: -32601 } }), false);
  assert.equal(isUnauthorizedControlResult({ error: { code: -32020 } }), false); // the OLD code no longer matches
  assert.equal(isUnauthorizedControlResult(null), false);
  assert.equal(isUnauthorizedControlResult(undefined), false);
});

// ---- Hosted fallback target ----

test('HOSTED_RPC_FALLBACK is the canonical hosted endpoint (rpc.dig.net)', () => {
  assert.equal(HOSTED_RPC_FALLBACK, 'https://rpc.dig.net/');
});

// ---- The manage-vs-install decision ----

test('decideControlView → "manage" with the reachable base when a local dig-node answers', async () => {
  // resolver resolves to the branded dig.local base (preferred).
  const resolveNode = async () => 'http://dig.local';
  const view = await decideControlView({ resolveNode });
  assert.equal(view.mode, 'manage');
  assert.equal(view.base, 'http://dig.local');
  // In manage mode, control.* RPCs target the LOCAL node (never the hosted fallback).
  assert.equal(view.controlEndpoint, 'http://dig.local/');
  assert.equal(view.localNode, true);
});

test('decideControlView → "manage" with the localhost fallback base', async () => {
  const resolveNode = async () => 'http://localhost:8080';
  const view = await decideControlView({ resolveNode });
  assert.equal(view.mode, 'manage');
  assert.equal(view.base, 'http://localhost:8080');
  assert.equal(view.controlEndpoint, 'http://localhost:8080/');
});

test('decideControlView → "install" when NO local dig-node is reachable', async () => {
  const resolveNode = async () => null;
  const view = await decideControlView({ resolveNode });
  assert.equal(view.mode, 'install');
  assert.equal(view.localNode, false);
  assert.equal(view.base, null);
  // No local node → control.* management is unavailable; control endpoint is null.
  assert.equal(view.controlEndpoint, null);
});

test('decideControlView always reports the hosted read fallback so the read path keeps working', async () => {
  // Whether or not a local node exists, READ content still resolves — via the local node when
  // present, else transparently via rpc.dig.net. The view carries the fallback target so the
  // UI can state honestly that reads keep working without a node.
  const withNode = await decideControlView({ resolveNode: async () => 'http://dig.local' });
  assert.equal(withNode.readFallback, HOSTED_RPC_FALLBACK);

  const noNode = await decideControlView({ resolveNode: async () => null });
  assert.equal(noNode.readFallback, HOSTED_RPC_FALLBACK);
});

test('decideControlView treats a thrown/failed resolver as "install" (honest: no node)', async () => {
  const resolveNode = async () => { throw new Error('probe blew up'); };
  const view = await decideControlView({ resolveNode });
  assert.equal(view.mode, 'install');
  assert.equal(view.localNode, false);
});

test('decideControlView honours a custom hosted fallback (options-page override)', async () => {
  const view = await decideControlView({
    resolveNode: async () => null,
    hostedFallback: 'https://my-rpc.example/',
  });
  assert.equal(view.readFallback, 'https://my-rpc.example/');
});

// ---- The Control Panel view model (what the popup renders) ----
//
// #82: the view model returns react-intl MESSAGE IDS (+ interpolation values) for every piece of
// prose, not raw English strings — ControlTab.tsx is the sole FormattedMessage consumer, so the
// actual copy lives in the message catalogs (14-locale translated). The CONTENT-quality assertions
// that used to run against raw strings here (jargon-free, "full experience", honest read-fallback
// wording) now run against the English catalog directly — see `dig-control-copy.test.ts`.

test('controlPanelViewModel: an open node that returned control.status → manage + node stats', () => {
  const vm = controlPanelViewModel({
    mode: 'manage', localNode: true, base: 'http://dig.local',
    controlEndpoint: 'http://dig.local/', readFallback: HOSTED_RPC_FALLBACK,
    authRequired: false,
    status: {
      running: true, upstream: 'https://rpc.dig.net', hosted_store_count: 3,
      cached_capsule_count: 7, cache: { used_bytes: 1048576 }, sync: { available: true },
    },
  });
  assert.equal(vm.mode, 'manage');
  assert.equal(vm.nodeOnline, true);
  assert.equal(vm.base, 'http://dig.local');
  assert.equal(vm.hasStats, true);
  assert.equal(vm.stats!.hostedStores, 3);
  assert.equal(vm.stats!.cachedCapsules, 7);
  assert.equal(vm.stats!.syncOn, true);
  assert.equal(vm.upstream, 'https://rpc.dig.net');
  // Even an open node deep-links full (mutating) management to the native browser.
  assert.equal(vm.deepLinkBrowser, true);
  // CLARITY (#131): in manage mode reads resolve LOCALLY — the id must be the "local" variant.
  assert.equal(vm.readFallback.id, 'control.readFallback.local');
  // The default (non-auth-required) manage note.
  assert.equal(vm.noteId, 'control.note.default');
});

test('controlPanelViewModel: a token-gated node (UNAUTHORIZED) → manage, node-present, no stats', () => {
  const vm = controlPanelViewModel({
    mode: 'manage', localNode: true, base: 'http://localhost:8080',
    controlEndpoint: 'http://localhost:8080/', readFallback: HOSTED_RPC_FALLBACK,
    authRequired: true, status: null,
  });
  assert.equal(vm.mode, 'manage');
  assert.equal(vm.nodeOnline, true);
  assert.equal(vm.hasStats, false, 'no control.status payload → no stat grid');
  assert.equal(vm.authRequired, true);
  assert.equal(vm.deepLinkBrowser, true);
  // The auth-required note (explains full management needs the native browser).
  assert.equal(vm.noteId, 'control.note.authRequired');
});

test('controlPanelViewModel: no node → install landing with the honest read-fallback line', () => {
  const vm = controlPanelViewModel({
    mode: 'install', localNode: false, base: null, controlEndpoint: null,
    readFallback: 'https://rpc.dig.net/', authRequired: false, status: null,
  });
  assert.equal(vm.mode, 'install');
  assert.equal(vm.nodeOnline, false);
  assert.equal(vm.install.installUrl, 'https://github.com/DIG-Network/dig-installer/releases');
  assert.equal(vm.readFallback.id, 'control.readFallback.hosted');
  assert.equal(vm.readFallback.values?.endpoint, 'https://rpc.dig.net/');
});

// ---- The install prompt copy ----

test('controlInstallPrompt names the dig-node + installer via message ids (no raw prose)', () => {
  const p = controlInstallPrompt();
  assert.equal(p.titleId, 'control.install.title');
  assert.equal(p.bodyId, 'control.install.body');
  // The installer URL is the universal installer releases page (same as dig-node-status.mjs).
  assert.equal(p.installUrl, 'https://github.com/DIG-Network/dig-installer/releases');
});
