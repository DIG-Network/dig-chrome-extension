/**
 * Tests for the injected window.chia provider's self-describing surface + error contract.
 *
 * Before this pass the injected provider exposed only isDIG/isConnected/request/connect/on/off
 * — a dapp or agent had to hard-code the method list and could not feature-detect the version
 * or transport. And thrown errors used ad-hoc sentinels (-1, raw HTTP status) with no
 * documented meaning. This pass adds:
 *   - window.chia.version / .info{isDIG,transport,edition}
 *   - window.chia.methods (the WALLET_METHODS catalogue) + a chip0002_getMethods request
 *   - a documented, standard-aligned thrown-error code contract (4001/4100/4200) — the same
 *     codes the native DIG Browser provider uses, so the two stay byte-aligned.
 *
 * The provider's pure logic is factored into buildProvider() in dig-provider-core.mjs so it
 * is unit-testable under `node --test` without a DOM. dig-provider.js (the injected IIFE)
 * imports nothing — it inlines the same surface — so this test pins the core that the IIFE
 * mirrors via a structure assertion.
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  WALLET_PROVIDER_VERSION,
  PROVIDER_INFO,
  PROVIDER_ERROR_CODES,
  buildProvider,
  mapEnvelopeToError,
} from '../dig-provider-core.mjs';
import { WALLET_METHODS } from '../wallet-methods.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

test('PROVIDER_INFO advertises a self-describing capability object', () => {
  assert.equal(PROVIDER_INFO.isDIG, true);
  assert.equal(PROVIDER_INFO.transport, 'walletconnect');
  assert.equal(PROVIDER_INFO.edition, 'extension');
});

test('PROVIDER_ERROR_CODES are the standard wallet codes (4001/4100/4200)', () => {
  // Aligned with EIP-1193 / CHIP-0002 conventions and the native DIG Browser provider.
  assert.equal(PROVIDER_ERROR_CODES.USER_REJECTED, 4001);
  assert.equal(PROVIDER_ERROR_CODES.UNAUTHORIZED, 4100);
  assert.equal(PROVIDER_ERROR_CODES.UNSUPPORTED_METHOD, 4200);
  assert.equal(PROVIDER_ERROR_CODES.DISCONNECTED, 4900);
});

test('buildProvider exposes version, info, and a methods catalogue', () => {
  const provider = buildProvider({ bridgeCall: async () => ({ status: 200, body: { data: {} } }), version: '1.2.3' });
  assert.equal(provider.isDIG, true);
  assert.equal(provider.version, '1.2.3');
  assert.deepEqual(provider.info, PROVIDER_INFO);
  assert.deepEqual(provider.methods, WALLET_METHODS);
  assert.equal(typeof provider.request, 'function');
  assert.equal(typeof provider.connect, 'function');
  assert.equal(typeof provider.on, 'function');
  assert.equal(typeof provider.off, 'function');
});

test('request({method:"chip0002_getMethods"}) returns the method catalogue locally', async () => {
  let called = false;
  const provider = buildProvider({
    bridgeCall: async () => { called = true; return { status: 200, body: { data: {} } }; },
    version: '1.0.0',
  });
  const methods = await provider.request({ method: 'chip0002_getMethods' });
  assert.deepEqual(methods, WALLET_METHODS);
  assert.equal(called, false, 'getMethods must be answered locally, not over the bridge');
});

test('mapEnvelopeToError: a 202 pending maps to USER_REJECTED (4001) + pending flag', () => {
  const e = mapEnvelopeToError({ status: 202, body: {} });
  assert.equal(e.code, 4001);
  assert.equal(e.pending, true);
});

test('mapEnvelopeToError: a 401 maps to UNAUTHORIZED (4100)', () => {
  const e = mapEnvelopeToError({ status: 401, body: { error: 'Origin not connected' } });
  assert.equal(e.code, 4100);
});

test('mapEnvelopeToError: a 404 maps to UNSUPPORTED_METHOD (4200)', () => {
  const e = mapEnvelopeToError({ status: 404, body: { error: 'Unsupported method: chip0002_foo' } });
  assert.equal(e.code, 4200);
});

test('mapEnvelopeToError: a 503/502 maps to DISCONNECTED (4900)', () => {
  assert.equal(mapEnvelopeToError({ status: 503, body: {} }).code, 4900);
  assert.equal(mapEnvelopeToError({ status: 502, body: { error: 'relay' } }).code, 4900);
});

test('mapEnvelopeToError: an absent envelope maps to DISCONNECTED (4900), not a sentinel -1', () => {
  const e = mapEnvelopeToError(null);
  assert.equal(e.code, 4900);
});

test('request resolves body.data on a 200', async () => {
  const provider = buildProvider({
    bridgeCall: async () => ({ status: 200, body: { data: { address: 'xch1...' } } }),
    version: '1.0.0',
  });
  const r = await provider.request({ method: 'chip0002_getPublicKeys' });
  assert.deepEqual(r, { address: 'xch1...' });
});

test('request throws an error carrying a standard code on a 4xx', async () => {
  const provider = buildProvider({
    bridgeCall: async () => ({ status: 401, body: { error: 'nope' } }),
    version: '1.0.0',
  });
  await assert.rejects(
    () => provider.request({ method: 'chip0002_getPublicKeys' }),
    (e) => { assert.equal(e.code, 4100); return true; }
  );
});

test('the injected IIFE (dig-provider.js) stays in lockstep with the core', () => {
  // The injected file cannot `import` (it runs in the page MAIN world), so it inlines the
  // same surface. Guard that it actually exposes the new affordances so the two never drift.
  const src = readFileSync(join(__dirname, '..', 'dig-provider.js'), 'utf8');
  assert.match(src, /chip0002_getMethods/, 'injected provider must answer chip0002_getMethods');
  assert.match(src, /window\.chia\.methods|methods:/, 'injected provider must expose .methods');
  assert.match(src, /version:/, 'injected provider must expose .version');
  assert.match(src, /info:/, 'injected provider must expose .info');
  assert.match(src, /4001/, 'injected provider must use the 4001 user-rejected code');
  assert.match(src, /4100/, 'injected provider must use the 4100 unauthorized code');
  assert.match(src, /4200/, 'injected provider must use the 4200 unsupported code');
  // Goby-compat surface must be inlined too (see loroco parity tests below).
  assert.match(src, /isGoby/, 'injected provider must advertise isGoby');
  assert.match(src, /requestAccounts/, 'injected provider must expose requestAccounts');
  assert.match(src, /walletSwitchChain/, 'injected provider must expose walletSwitchChain');
});

// ─── Goby / CHIP-0002 / Sage-WC2 compatibility (loroco window.chia parity) ──────
// A dApp built for Goby / Sage's WC2 API expects: identity flags (isGoby), Goby-legacy
// DIRECT methods on the object (provider.getPublicKeys(), .transfer(), …) rather than
// only request({method}), the requestAccounts/accounts helpers, walletSwitchChain, and
// isConnected() as a callable. buildProvider must expose all of these as a SUPERSET of
// the existing DIG surface.

/** A bridgeCall spy that records (method, params) and returns canned data per method. */
function spyBridge() {
  const calls = [];
  const bridgeCall = async (method, params) => {
    calls.push({ method, params });
    if (method === 'chia_getAddress') return { status: 200, body: { data: { address: 'xch1testaddr' } } };
    if (method === 'chia_send') return { status: 200, body: { data: { id: '0xspend' } } };
    if (method === 'chip0002_connect') return { status: 200, body: { data: true } };
    return { status: 200, body: { data: {} } };
  };
  return { calls, bridgeCall };
}

test('provider advertises Goby identity flags (isGoby/name/apiVersion) alongside isDIG', () => {
  const { bridgeCall } = spyBridge();
  const p = buildProvider({ bridgeCall, version: '1.0.0' });
  assert.equal(p.isDIG, true);
  assert.equal(p.isGoby, true);
  assert.equal(typeof p.name, 'string');
  assert.ok(p.name.length > 0);
  assert.equal(typeof p.apiVersion, 'string');
});

test('isConnected() is a callable that flips true after connect', async () => {
  const { bridgeCall } = spyBridge();
  const p = buildProvider({ bridgeCall, version: '1.0.0' });
  assert.equal(typeof p.isConnected, 'function');
  assert.equal(p.isConnected(), false);
  await p.connect();
  assert.equal(p.isConnected(), true);
  assert.equal(p.chainId, 'mainnet'); // DIG is Chia mainnet
});

test('Goby-legacy direct methods exist on the provider object', () => {
  const { bridgeCall } = spyBridge();
  const p = buildProvider({ bridgeCall, version: '1.0.0' });
  for (const m of [
    'connect', 'getPublicKeys', 'filterUnlockedCoins', 'getAssetCoins', 'getAssetBalance',
    'signCoinSpends', 'signMessage', 'transfer', 'sendTransaction', 'createOffer', 'takeOffer',
    'cancelOffer', 'signMessageByAddress', 'getNFTs', 'getNFTInfo', 'walletSwitchChain',
    'walletWatchAsset', 'requestAccounts', 'accounts',
  ]) {
    assert.equal(typeof p[m], 'function', `${m} is a direct method`);
  }
});

test('request({method:"transfer"}) routes to chia_send with to→address remap', async () => {
  const { calls, bridgeCall } = spyBridge();
  const p = buildProvider({ bridgeCall, version: '1.0.0' });
  await p.request({ method: 'transfer', params: { to: 'xch1dest', amount: 7, fee: 1 } });
  const sent = calls.find((c) => c.method === 'chia_send');
  assert.ok(sent, 'transfer must reach the broker as chia_send');
  assert.deepEqual(sent.params, { amount: 7, fee: 1, address: 'xch1dest' });
});

test('the direct transfer() method routes identically to request', async () => {
  const { calls, bridgeCall } = spyBridge();
  const p = buildProvider({ bridgeCall, version: '1.0.0' });
  await p.transfer({ to: 'xch1dest2', amount: 3 });
  const sent = calls.find((c) => c.method === 'chia_send');
  assert.ok(sent);
  assert.deepEqual(sent.params, { amount: 3, address: 'xch1dest2' });
});

test('request({method:"getPublicKeys"}) routes to chip0002_getPublicKeys', async () => {
  const { calls, bridgeCall } = spyBridge();
  const p = buildProvider({ bridgeCall, version: '1.0.0' });
  await p.request({ method: 'getPublicKeys' });
  assert.ok(calls.some((c) => c.method === 'chip0002_getPublicKeys'));
});

test('requestAccounts() connects then returns the address list + caches selectedAddress', async () => {
  const { bridgeCall } = spyBridge();
  const p = buildProvider({ bridgeCall, version: '1.0.0' });
  const accts = await p.requestAccounts();
  assert.deepEqual(accts, ['xch1testaddr']);
  assert.equal(p.isConnected(), true);
  assert.equal(p.selectedAddress, 'xch1testaddr');
});

test('accounts() throws 4900 when not connected, returns addresses once connected', async () => {
  const { bridgeCall } = spyBridge();
  const p = buildProvider({ bridgeCall, version: '1.0.0' });
  await assert.rejects(() => p.accounts(), (e) => { assert.equal(e.code, 4900); return true; });
  await p.connect();
  assert.deepEqual(await p.accounts(), ['xch1testaddr']);
});

test('walletSwitchChain accepts mainnet locally and rejects other chains as unsupported', async () => {
  const { calls, bridgeCall } = spyBridge();
  const p = buildProvider({ bridgeCall, version: '1.0.0' });
  assert.equal(await p.walletSwitchChain({ chainId: 'mainnet' }), null);
  assert.equal(calls.length, 0, 'mainnet switch is answered locally, no bridge call');
  await assert.rejects(
    () => p.walletSwitchChain({ chainId: 'testnet11' }),
    (e) => { assert.equal(e.code, 4200); return true; },
  );
});

test('on/off/removeListener accept chainChanged and accountChanged without throwing', () => {
  const { bridgeCall } = spyBridge();
  const p = buildProvider({ bridgeCall, version: '1.0.0' });
  const fn = () => {};
  assert.doesNotThrow(() => p.on('chainChanged', fn));
  assert.doesNotThrow(() => p.on('accountChanged', fn));
  assert.equal(typeof p.removeListener, 'function');
  assert.doesNotThrow(() => p.removeListener('chainChanged', fn));
  assert.doesNotThrow(() => p.off('accountChanged', fn));
});
