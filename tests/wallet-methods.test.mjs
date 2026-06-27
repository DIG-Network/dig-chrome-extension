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
  normalizeMethod,
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
