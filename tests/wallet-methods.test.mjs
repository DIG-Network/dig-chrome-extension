/**
 * Tests for the CHIP-0002 / Chia wallet method surface (wallet-methods.mjs).
 *
 * The injected `window.chia` provider must expose the SAME method set + namespacing
 * rules as the native DIG Browser (SYSTEM.md → dig-wallet WC method surface), so a dapp
 * behaves identically across the native browser and the extension. These pin the surface
 * and the normalize/state-changing classification the broker relies on.
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WALLET_METHODS,
  CHIP0002_METHODS,
  CHIA_METHODS,
  STATE_CHANGING_METHODS,
  GOBY_ALIASES,
  normalizeMethod,
  remapGobyParams,
  isSupportedMethod,
  isStateChanging,
} from '../wallet-methods.mjs';

test('surface matches SYSTEM.md dig-wallet method set', () => {
  // CHIP-0002 core
  for (const m of [
    'chip0002_chainId', 'chip0002_connect', 'chip0002_getPublicKeys',
    'chip0002_signMessage', 'chip0002_signCoinSpends',
    'chip0002_getAssetBalance', 'chip0002_getAssetCoins',
  ]) {
    assert.ok(WALLET_METHODS.includes(m), `${m} present`);
  }
  // chia_* set
  for (const m of [
    'chia_getAddress', 'chia_signMessageByAddress', 'chia_send', 'chia_getTransactions',
    'chia_getNfts', 'chia_transferNft', 'chia_mintNft', 'chia_bulkMintNfts',
    'chia_getDids', 'chia_createDidWallet', 'chia_transferDid',
    'chia_getOfferSummary', 'chia_createOffer', 'chia_takeOffer', 'chia_cancelOffer',
  ]) {
    assert.ok(WALLET_METHODS.includes(m), `${m} present`);
  }
});

test('WALLET_METHODS is the union of the two namespaces with no dupes', () => {
  assert.equal(WALLET_METHODS.length, CHIP0002_METHODS.length + CHIA_METHODS.length);
  assert.equal(new Set(WALLET_METHODS).size, WALLET_METHODS.length);
});

test('normalizeMethod namespaces bare names to chip0002_', () => {
  assert.equal(normalizeMethod('getPublicKeys'), 'chip0002_getPublicKeys');
  assert.equal(normalizeMethod('connect'), 'chip0002_connect');
});

test('normalizeMethod leaves already-namespaced names alone', () => {
  assert.equal(normalizeMethod('chip0002_connect'), 'chip0002_connect');
  assert.equal(normalizeMethod('chia_getAddress'), 'chia_getAddress');
});

test('isSupportedMethod accepts bare and namespaced supported names', () => {
  assert.ok(isSupportedMethod('getPublicKeys'));
  assert.ok(isSupportedMethod('chip0002_getPublicKeys'));
  assert.ok(isSupportedMethod('chia_getAddress'));
  assert.ok(!isSupportedMethod('chia_dropAllFunds'));
});

test('read methods are not state-changing; signing/sends are', () => {
  assert.ok(!isStateChanging('chip0002_getPublicKeys'));
  assert.ok(!isStateChanging('chia_getAddress'));
  assert.ok(!isStateChanging('chip0002_getAssetBalance'));
  assert.ok(isStateChanging('chip0002_signCoinSpends'));
  assert.ok(isStateChanging('signMessage')); // bare → chip0002_signMessage
  assert.ok(isStateChanging('chia_send'));
  assert.ok(isStateChanging('chia_takeOffer'));
});

test('STATE_CHANGING_METHODS is a subset of the supported surface', () => {
  for (const m of STATE_CHANGING_METHODS) {
    assert.ok(WALLET_METHODS.includes(m), `${m} is a real method`);
  }
});

// ─── Goby / CHIP-0002 / Sage-WC2 compatibility (loroco window.chia parity) ──────
// A dApp built for Goby (dexie.space, tibetswap, …) or Sage's WC2 API calls bare
// method names that don't map 1:1 to `chip0002_<name>` — e.g. `transfer` is Sage's
// `chia_send`, `createOffer` is `chia_createOffer`. normalizeMethod must route these
// via the alias table, not blindly prepend `chip0002_`.

test('GOBY_ALIASES routes Goby/Sage names to the right broker namespace', () => {
  // CHIP-0002 core → chip0002_
  assert.equal(GOBY_ALIASES.getPublicKeys, 'chip0002_getPublicKeys');
  assert.equal(GOBY_ALIASES.signCoinSpends, 'chip0002_signCoinSpends');
  assert.equal(GOBY_ALIASES.filterUnlockedCoins, 'chip0002_filterUnlockedCoins');
  // Goby extensions / Sage WC2 → chia_
  assert.equal(GOBY_ALIASES.transfer, 'chia_send');
  assert.equal(GOBY_ALIASES.getAddress, 'chia_getAddress');
  assert.equal(GOBY_ALIASES.getNFTs, 'chia_getNfts');
  assert.equal(GOBY_ALIASES.createOffer, 'chia_createOffer');
  assert.equal(GOBY_ALIASES.takeOffer, 'chia_takeOffer');
  assert.equal(GOBY_ALIASES.cancelOffer, 'chia_cancelOffer');
});

test('normalizeMethod routes Goby-legacy names through the alias table', () => {
  assert.equal(normalizeMethod('transfer'), 'chia_send');
  assert.equal(normalizeMethod('createOffer'), 'chia_createOffer');
  assert.equal(normalizeMethod('getNFTs'), 'chia_getNfts');
  // CHIP-0002 core bare names still land in chip0002_ (unchanged behaviour)
  assert.equal(normalizeMethod('getPublicKeys'), 'chip0002_getPublicKeys');
  assert.equal(normalizeMethod('signCoinSpends'), 'chip0002_signCoinSpends');
  // already-namespaced pass through untouched
  assert.equal(normalizeMethod('chia_getAddress'), 'chia_getAddress');
  assert.equal(normalizeMethod('chip0002_connect'), 'chip0002_connect');
  // an unknown bare name falls back to chip0002_ namespacing
  assert.equal(normalizeMethod('somethingNew'), 'chip0002_somethingNew');
});

test('filterUnlockedCoins is a supported CHIP-0002 method', () => {
  assert.ok(WALLET_METHODS.includes('chip0002_filterUnlockedCoins'));
  assert.ok(isSupportedMethod('filterUnlockedCoins'));
});

test('remapGobyParams remaps Goby transfer{to} to Sage chia_send{address}', () => {
  assert.deepEqual(
    remapGobyParams('transfer', { to: 'xch1abc', amount: 5, fee: 1 }),
    { amount: 5, fee: 1, address: 'xch1abc' },
  );
  // an explicit address already present is left as-is
  assert.deepEqual(
    remapGobyParams('transfer', { address: 'xch1def', amount: 5 }),
    { address: 'xch1def', amount: 5 },
  );
  // non-transfer methods pass params through untouched
  assert.deepEqual(remapGobyParams('chia_send', { address: 'xch1', amount: 2 }), { address: 'xch1', amount: 2 });
  assert.equal(remapGobyParams('getPublicKeys', undefined), undefined);
});
