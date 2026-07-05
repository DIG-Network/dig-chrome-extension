/**
 * Tests for the pure self-custody session logic (custody-session.mjs) — the SW's lifecycle decision
 * layer. No chrome.*; every branch of TTL math + lock-state derivation is exercised here.
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CUSTODY_ACTIONS,
  isCustodyAction,
  resolveTtlMinutes,
  computeUnlockExpiry,
  isUnlockExpired,
  deriveLockState,
  computeLockSnapshot,
  resolveCoinsetUrl,
  DEFAULT_COINSET_URL,
  LOCK_STATE,
  DEFAULT_UNLOCK_TTL_MINUTES,
  MIN_UNLOCK_TTL_MINUTES,
  MAX_UNLOCK_TTL_MINUTES,
} from '../custody-session.mjs';

test('CUSTODY_ACTIONS lists exactly the offscreen-routed vault ops', () => {
  assert.deepEqual(
    [...CUSTODY_ACTIONS].sort(),
    [
      'createWallet',
      'getCustodyBalances',
      'getLockState',
      'getReceiveAddress',
      'importWallet',
      'lockWallet',
      'revealPhrase',
      'unlockWallet',
      'prepareSend',
      'confirmSend',
      'sendStatus',
      'getActivity',
      'makeOffer',
      'inspectOffer',
      'prepareTrade',
      'confirmTrade',
      'listNfts',
      'prepareNftTransfer',
      'confirmNftTransfer',
    ].sort(),
  );
});

test('resolveCoinsetUrl uses the override when set, else the coinset default', () => {
  assert.equal(resolveCoinsetUrl(undefined), DEFAULT_COINSET_URL);
  assert.equal(resolveCoinsetUrl({}), DEFAULT_COINSET_URL);
  assert.equal(resolveCoinsetUrl({ chainRpcUrl: '  ' }), DEFAULT_COINSET_URL);
  assert.equal(resolveCoinsetUrl({ chainRpcUrl: 'https://my.node/rpc' }), 'https://my.node/rpc');
});

test('isCustodyAction recognises custody actions and rejects others', () => {
  assert.ok(isCustodyAction('unlockWallet'));
  assert.ok(isCustodyAction('createWallet'));
  assert.ok(!isCustodyAction('proxyRequest'));
  assert.ok(!isCustodyAction('walletRpc'));
  assert.ok(!isCustodyAction(undefined));
  assert.ok(!isCustodyAction(null));
});

test('resolveTtlMinutes defaults, clamps, and floors', () => {
  assert.equal(resolveTtlMinutes(undefined), DEFAULT_UNLOCK_TTL_MINUTES);
  assert.equal(resolveTtlMinutes({}), DEFAULT_UNLOCK_TTL_MINUTES);
  assert.equal(resolveTtlMinutes({ unlockTtlMinutes: 'nope' }), DEFAULT_UNLOCK_TTL_MINUTES);
  assert.equal(resolveTtlMinutes({ unlockTtlMinutes: 5 }), 5);
  assert.equal(resolveTtlMinutes({ unlockTtlMinutes: 3.9 }), 3); // floored
  assert.equal(resolveTtlMinutes({ unlockTtlMinutes: 0 }), MIN_UNLOCK_TTL_MINUTES); // clamped up
  assert.equal(resolveTtlMinutes({ unlockTtlMinutes: 9999 }), MAX_UNLOCK_TTL_MINUTES); // clamped down
});

test('computeUnlockExpiry adds the TTL window in ms', () => {
  assert.equal(computeUnlockExpiry(1000, 10), 1000 + 10 * 60_000);
  assert.equal(computeUnlockExpiry(0), DEFAULT_UNLOCK_TTL_MINUTES * 60_000);
});

test('isUnlockExpired treats missing/invalid/past as expired, future as live', () => {
  assert.ok(isUnlockExpired(undefined, 100));
  assert.ok(isUnlockExpired(0, 100));
  assert.ok(isUnlockExpired(NaN, 100));
  assert.ok(isUnlockExpired(-5, 100));
  assert.ok(isUnlockExpired(100, 100)); // exactly at expiry = expired
  assert.ok(isUnlockExpired(100, 200));
  assert.ok(!isUnlockExpired(200, 100));
});

test('deriveLockState: no keystore → none', () => {
  assert.equal(
    deriveLockState({ hasKeystore: false, hasKeyInVault: false, unlockExpiry: 0, now: 1 }),
    LOCK_STATE.NONE,
  );
});

test('deriveLockState: keystore present but no key in vault → locked', () => {
  assert.equal(
    deriveLockState({ hasKeystore: true, hasKeyInVault: false, unlockExpiry: 9e12, now: 1 }),
    LOCK_STATE.LOCKED,
  );
});

test('deriveLockState: key in vault but TTL expired → locked', () => {
  assert.equal(
    deriveLockState({ hasKeystore: true, hasKeyInVault: true, unlockExpiry: 50, now: 100 }),
    LOCK_STATE.LOCKED,
  );
});

test('deriveLockState: keystore + key in vault + fresh TTL → unlocked', () => {
  assert.equal(
    deriveLockState({ hasKeystore: true, hasKeyInVault: true, unlockExpiry: 200, now: 100 }),
    LOCK_STATE.UNLOCKED,
  );
});

// ── computeLockSnapshot: the storage-only snapshot the SW returns for getLockState ──
// The lock state the UI reads is derived PURELY from persisted facts — whether the encrypted
// keystore blob exists in chrome.storage.local and the non-secret unlock-expiry kept in
// chrome.storage.session — with NO round-trip to the offscreen vault. That decoupling is the fix
// for the #68 "Loading wallet" hang: a no-wallet user (who has no offscreen document at all) always
// resolves getLockState instantly to `none`, so CustodyGate lands on onboarding instead of waiting
// on a vault that will never answer. The fresh unlock-expiry is the faithful proxy for "unlocked":
// it is set on create/import/unlock and cleared on lock / TTL lapse.
test('computeLockSnapshot: no keystore → none, purely from storage (never needs the vault)', () => {
  // The regression case: even with a stale/fresh expiry and an active id lingering, no blob = none.
  assert.deepEqual(
    computeLockSnapshot({ hasKeystore: false, activeWalletId: 'main', unlockExpiry: 9e12, now: 100 }),
    { lockState: LOCK_STATE.NONE, activeWalletId: null, unlockExpiry: null },
  );
});

test('computeLockSnapshot: keystore + no unlock session → locked', () => {
  assert.equal(
    computeLockSnapshot({ hasKeystore: true, unlockExpiry: null, now: 100 }).lockState,
    LOCK_STATE.LOCKED,
  );
});

test('computeLockSnapshot: keystore + expired unlock session → locked', () => {
  assert.equal(
    computeLockSnapshot({ hasKeystore: true, unlockExpiry: 50, now: 100 }).lockState,
    LOCK_STATE.LOCKED,
  );
});

test('computeLockSnapshot: keystore + fresh unlock session → unlocked (carries id + expiry)', () => {
  assert.deepEqual(
    computeLockSnapshot({ hasKeystore: true, activeWalletId: 'main', unlockExpiry: 200, now: 100 }),
    { lockState: LOCK_STATE.UNLOCKED, activeWalletId: 'main', unlockExpiry: 200 },
  );
});
