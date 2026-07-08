/**
 * Tests for the pure self-custody session logic (custody-session.mjs) — the SW's lifecycle decision
 * layer. No chrome.*; every branch of TTL math + lock-state derivation is exercised here.
 * Run: node --test tests/
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  CUSTODY_ACTIONS,
  isCustodyAction,
  isSessionRenewingAction,
  shouldApplyRenewal,
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
  prepareSendVaultRequest,
} from '@/lib/custody-session';

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
      'listWallets',
      'switchWallet',
      'renameWallet',
      'removeWallet',
      'setActiveIndex',
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
      'prepareNftMint',
      'confirmNftMint',
      'listDids',
      'prepareDidCreate',
      'confirmDidCreate',
      'prepareDidTransfer',
      'confirmDidTransfer',
      'prepareDidProfileUpdate',
      'confirmDidProfileUpdate',
      'prepareNftDidAssign',
      'confirmNftDidAssign',
      'listCoins',
      'prepareSplit',
      'prepareCombine',
      'listClawbacks',
      'prepareClawbackAction',
      'confirmClawbackAction',
    ].sort(),
  );
});

// Coin control (#91): a hand-picked coin selection must reach the vault so it overrides auto-selection.
test('prepareSendVaultRequest forwards a hand-picked coin selection (#91)', () => {
  const req = prepareSendVaultRequest(
    { recipient: 'xch1r', amount: '5', fee: '0', coinIds: ['aa', 'bb'] },
    DEFAULT_COINSET_URL,
  );
  assert.deepEqual(req.coinIds, ['aa', 'bb']);
});

test('resolveCoinsetUrl uses the override when set, else the coinset default', () => {
  assert.equal(resolveCoinsetUrl(undefined), DEFAULT_COINSET_URL);
  assert.equal(resolveCoinsetUrl({}), DEFAULT_COINSET_URL);
  assert.equal(resolveCoinsetUrl({ chainRpcUrl: '  ' }), DEFAULT_COINSET_URL);
  assert.equal(resolveCoinsetUrl({ chainRpcUrl: 'https://my.node/rpc' }), 'https://my.node/rpc');
});

// Regression #121 (money-critical): the SW prepareSend handler MUST forward `assetId` to the vault.
// Dropping it made the vault (`isCat = !!req.assetId`) build a native XCH send for a selected CAT —
// a wrong-asset transfer shipped in v1.31.0. This is the exact mapping the SW handler now uses.
test('prepareSendVaultRequest forwards the CAT assetId to the vault (#121)', () => {
  const req = prepareSendVaultRequest(
    { recipient: 'xch1recipient', amount: '5', fee: '0', assetId: '87ed22cdf4133b8d25f2bc79ec4a5ff2333fd89b0ae3a456320eb75ec6be25be' },
    'https://api.coinset.org',
  );
  assert.equal(req.op, 'prepareSend');
  assert.equal(req.recipient, 'xch1recipient');
  assert.equal(req.amount, '5');
  assert.equal(req.fee, '0');
  assert.equal(req.coinsetUrl, 'https://api.coinset.org');
  // The load-bearing assertion: the token's TAIL must reach the vault so it builds a CAT, not XCH.
  assert.equal(req.assetId, '87ed22cdf4133b8d25f2bc79ec4a5ff2333fd89b0ae3a456320eb75ec6be25be');
});

test('prepareSendVaultRequest omits assetId for a native XCH send', () => {
  const req = prepareSendVaultRequest({ recipient: 'xch1r', amount: '1', fee: '0' }, DEFAULT_COINSET_URL);
  assert.equal(req.assetId, undefined);
});

// #152 — a send-with-clawback window must reach the vault so it locks the coin instead of a plain send.
test('prepareSendVaultRequest forwards clawbackSeconds (#152)', () => {
  const req = prepareSendVaultRequest(
    { recipient: 'xch1r', amount: '5', fee: '0', clawbackSeconds: '1751200000' },
    DEFAULT_COINSET_URL,
  );
  assert.equal(req.clawbackSeconds, '1751200000');
});

// #105 — an optional memo/note must reach the vault so it lands in the recipient's CREATE_COIN.
test('prepareSendVaultRequest forwards an optional memo (#105)', () => {
  const req = prepareSendVaultRequest({ recipient: 'xch1r', amount: '5', fee: '0', memo: 'thanks!' }, DEFAULT_COINSET_URL);
  assert.equal(req.memo, 'thanks!');
});

test('prepareSendVaultRequest omits memo for a plain send', () => {
  const req = prepareSendVaultRequest({ recipient: 'xch1r', amount: '1', fee: '0' }, DEFAULT_COINSET_URL);
  assert.equal(req.memo, undefined);
});

test('prepareSendVaultRequest omits clawbackSeconds for a plain send', () => {
  const req = prepareSendVaultRequest({ recipient: 'xch1r', amount: '1', fee: '0' }, DEFAULT_COINSET_URL);
  assert.equal(req.clawbackSeconds, undefined);
});

test('isCustodyAction recognises the #152 clawback actions', () => {
  assert.ok(isCustodyAction('listClawbacks'));
  assert.ok(isCustodyAction('prepareClawbackAction'));
  assert.ok(isCustodyAction('confirmClawbackAction'));
});

test('isCustodyAction recognises custody actions and rejects others', () => {
  assert.ok(isCustodyAction('unlockWallet'));
  assert.ok(isCustodyAction('createWallet'));
  assert.ok(!isCustodyAction('proxyRequest'));
  assert.ok(!isCustodyAction('walletRpc'));
  assert.ok(!isCustodyAction(undefined));
  assert.ok(!isCustodyAction(null));
});

test('DEFAULT_UNLOCK_TTL_MINUTES is a MetaMask-style idle default (#155)', () => {
  // 15 minutes: long enough that active use never trips it (isSessionRenewingAction slides the
  // window forward on every real wallet action, #155), short enough to matter if truly idle.
  assert.equal(DEFAULT_UNLOCK_TTL_MINUTES, 15);
});

test('isSessionRenewingAction: real wallet activity renews; a status check or lock does not (#155)', () => {
  // Merely asking "am I unlocked?" is not activity — polling it must never keep a session alive
  // forever by itself.
  assert.ok(!isSessionRenewingAction('getLockState'));
  // Locking is the OPPOSITE of activity — it must never resurrect the session it just ended.
  assert.ok(!isSessionRenewingAction('lockWallet'));
  // Non-custody / garbage input never renews.
  assert.ok(!isSessionRenewingAction('proxyRequest'));
  assert.ok(!isSessionRenewingAction('walletRpc'));
  assert.ok(!isSessionRenewingAction(undefined));
  assert.ok(!isSessionRenewingAction(null));
  // Every other custody action IS real wallet use and slides the idle window forward.
  assert.ok(isSessionRenewingAction('unlockWallet'));
  assert.ok(isSessionRenewingAction('createWallet'));
  assert.ok(isSessionRenewingAction('importWallet'));
  assert.ok(isSessionRenewingAction('switchWallet'));
  assert.ok(isSessionRenewingAction('getReceiveAddress'));
  assert.ok(isSessionRenewingAction('getCustodyBalances'));
  assert.ok(isSessionRenewingAction('prepareSend'));
  assert.ok(isSessionRenewingAction('confirmSend'));
  assert.ok(isSessionRenewingAction('getActivity'));
  assert.ok(isSessionRenewingAction('listWallets'));
  // Navigating the active derivation index (#165) is real wallet use too.
  assert.ok(isSessionRenewingAction('setActiveIndex'));
});

test('shouldApplyRenewal: an explicit lock racing a still-in-flight activity call always wins (#155)', () => {
  // The happy path: nothing else touched the expiry between the action's start and its finish.
  assert.ok(shouldApplyRenewal(1_000, 1_000));
  // The race this guards: the action started while unlocked (expiry 1000), but an explicit lock (or
  // the TTL sweep) cleared it before the action finished — renewal MUST be skipped, or a lock could
  // be silently undone by an activity call that was already in flight when it fired.
  assert.ok(!shouldApplyRenewal(1_000, undefined));
  assert.ok(!shouldApplyRenewal(1_000, null));
  // Another concurrent renewal already bumped it to a different value — don't stomp back to a
  // smaller/different expiry; the later renewal already stands.
  assert.ok(!shouldApplyRenewal(1_000, 2_000));
  // The action never observed a fresh unlock at all (started locked/none) — never renew.
  assert.ok(!shouldApplyRenewal(null, 1_000));
  assert.ok(!shouldApplyRenewal(undefined, 1_000));
  assert.ok(!shouldApplyRenewal(null, null));
});

test('resolveTtlMinutes defaults, clamps, and floors', () => {
  assert.equal(resolveTtlMinutes(undefined), DEFAULT_UNLOCK_TTL_MINUTES);
  assert.equal(resolveTtlMinutes({}), DEFAULT_UNLOCK_TTL_MINUTES);
  // Intentional bad runtime value (non-number) — exercises the type-guard fallback branch.
  assert.equal(resolveTtlMinutes({ unlockTtlMinutes: 'nope' as unknown as number }), DEFAULT_UNLOCK_TTL_MINUTES);
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
    computeLockSnapshot({ hasKeystore: false, activeWalletId: 'main', unlockExpiry: 9e12, activeIndex: 5, now: 100 }),
    { lockState: LOCK_STATE.NONE, activeWalletId: null, unlockExpiry: null, activeIndex: 0 },
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
    { lockState: LOCK_STATE.UNLOCKED, activeWalletId: 'main', unlockExpiry: 200, activeIndex: 0 },
  );
});

// ── Active derivation index in the snapshot (#165) ──
test('computeLockSnapshot: carries the active wallet\'s active derivation index when unlocked', () => {
  assert.deepEqual(
    computeLockSnapshot({ hasKeystore: true, activeWalletId: 'main', unlockExpiry: 200, activeIndex: 7, now: 100 }),
    { lockState: LOCK_STATE.UNLOCKED, activeWalletId: 'main', unlockExpiry: 200, activeIndex: 7 },
  );
});

test('computeLockSnapshot: activeIndex defaults to 0 when omitted', () => {
  assert.equal(computeLockSnapshot({ hasKeystore: true, unlockExpiry: 200, now: 100 }).activeIndex, 0);
});
