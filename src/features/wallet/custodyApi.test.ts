import { describe, it, expect, vi, afterEach } from 'vitest';
import { createStore } from '@/app/store';
import { custodyApi } from '@/features/wallet/custodyApi';

/**
 * The custody endpoints route over the SW seam, so we mock `chrome.runtime.sendMessage` with a
 * router keyed on `message.action` and assert the endpoints send the right action + surface the
 * reply (success → data, `{success:false}` → RTK Query error). No real keystore/offscreen here —
 * the vault crypto is covered by vault.test.ts + digwx1.test.ts.
 */
function mockSw(router: (msg: { action: string; [k: string]: unknown }) => unknown) {
  const fn = vi.fn((msg: unknown, cb?: (r: unknown) => void) => {
    const reply = router(msg as { action: string; [k: string]: unknown });
    if (cb) cb(reply);
    return Promise.resolve(reply);
  });
  (chrome.runtime as unknown as { sendMessage: typeof fn }).sendMessage = fn;
  return fn;
}

afterEach(() => vi.restoreAllMocks());

describe('custodyApi endpoints', () => {
  it('getLockState returns the SW lock state', async () => {
    mockSw((m) => (m.action === 'getLockState' ? { lockState: 'locked', activeWalletId: 'w1' } : { success: false }));
    const store = createStore();
    const res = await store.dispatch(custodyApi.endpoints.getLockState.initiate());
    expect(res.data).toMatchObject({ lockState: 'locked', activeWalletId: 'w1' });
  });

  it('createWallet sends the password/label and returns the once-shown phrase', async () => {
    const sw = mockSw((m) =>
      m.action === 'createWallet' ? { lockState: 'unlocked', mnemonic: 'word '.repeat(24).trim() } : { success: false },
    );
    const store = createStore();
    const res = await store.dispatch(custodyApi.endpoints.createWallet.initiate({ password: 'pw', label: 'main' }));
    expect(res.data?.lockState).toBe('unlocked');
    expect(res.data?.mnemonic?.split(' ')).toHaveLength(24);
    expect(sw).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'createWallet', password: 'pw', label: 'main' }),
      expect.any(Function),
    );
  });

  it('importWallet forwards the mnemonic + password', async () => {
    const sw = mockSw((m) => (m.action === 'importWallet' ? { lockState: 'unlocked' } : { success: false }));
    const store = createStore();
    const res = await store.dispatch(
      custodyApi.endpoints.importWallet.initiate({ mnemonic: 'abandon art', password: 'pw' }),
    );
    expect(res.data?.lockState).toBe('unlocked');
    expect(sw).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'importWallet', mnemonic: 'abandon art', password: 'pw' }),
      expect.any(Function),
    );
  });

  it('unlockWallet surfaces a wrong-password failure as an RTK Query error', async () => {
    mockSw((m) => (m.action === 'unlockWallet' ? { success: false, code: 'UNLOCK_FAILED', message: 'unlock failed' } : {}));
    const store = createStore();
    const res = await store.dispatch(custodyApi.endpoints.unlockWallet.initiate({ password: 'wrong' }));
    expect(res.error).toMatchObject({ code: 'UNLOCK_FAILED' });
  });

  it('unlockWallet succeeds and reports the fallback flag', async () => {
    mockSw((m) => (m.action === 'unlockWallet' ? { lockState: 'unlocked', usedFallback: true } : {}));
    const store = createStore();
    const res = await store.dispatch(custodyApi.endpoints.unlockWallet.initiate({ password: 'pw' }));
    expect(res.data).toMatchObject({ lockState: 'unlocked', usedFallback: true });
  });

  it('lockWallet returns the locked state', async () => {
    mockSw((m) => (m.action === 'lockWallet' ? { lockState: 'locked' } : {}));
    const store = createStore();
    const res = await store.dispatch(custodyApi.endpoints.lockWallet.initiate());
    expect(res.data?.lockState).toBe('locked');
  });

  it('getCoins lists the wallet coins for an asset (coin control #91)', async () => {
    const sw = mockSw((m) =>
      m.action === 'listCoins' ? { coins: [{ coinId: 'ab'.repeat(32), amount: '1000', confirmedHeight: 5 }] } : { success: false },
    );
    const store = createStore();
    const res = await store.dispatch(custodyApi.endpoints.getCoins.initiate({ assetId: 'cc' }));
    expect(res.data?.coins).toHaveLength(1);
    expect(sw).toHaveBeenCalledWith(expect.objectContaining({ action: 'listCoins', assetId: 'cc' }), expect.any(Function));
  });

  it('prepareSplit forwards coinIds + outputs and returns the coin-op summary', async () => {
    const sw = mockSw((m) =>
      m.action === 'prepareSplit' ? { pendingId: 'p1', coinOpSummary: { asset: 'XCH', kind: 'split', inputCoinCount: 1, outputCoinCount: 3, total: '9000', fee: '0' } } : {},
    );
    const store = createStore();
    const res = await store.dispatch(custodyApi.endpoints.prepareSplit.initiate({ coinIds: ['a1'], outputs: 3 }));
    expect(res.data?.coinOpSummary.kind).toBe('split');
    expect(sw).toHaveBeenCalledWith(expect.objectContaining({ action: 'prepareSplit', coinIds: ['a1'], outputs: 3 }), expect.any(Function));
  });

  it('prepareCombine forwards coinIds and returns the coin-op summary', async () => {
    const sw = mockSw((m) => (m.action === 'prepareCombine' ? { pendingId: 'p2', coinOpSummary: { asset: 'XCH', kind: 'combine', inputCoinCount: 3, outputCoinCount: 1, total: '6000', fee: '0' } } : {}));
    const store = createStore();
    const res = await store.dispatch(custodyApi.endpoints.prepareCombine.initiate({ coinIds: ['a', 'b', 'c'] }));
    expect(res.data?.coinOpSummary.outputCoinCount).toBe(1);
    expect(sw).toHaveBeenCalledWith(expect.objectContaining({ action: 'prepareCombine', coinIds: ['a', 'b', 'c'] }), expect.any(Function));
  });

  it('prepareSend forwards a hand-picked coinIds selection (#91)', async () => {
    const sw = mockSw((m) => (m.action === 'prepareSend' ? { pendingId: 'p3', summary: { asset: 'XCH', sent: '1', change: '0', fee: '0', recipientPuzzleHashHex: 'ab', coinCount: 1 } } : {}));
    const store = createStore();
    await store.dispatch(custodyApi.endpoints.prepareSend.initiate({ recipient: 'xch1r', amount: '1', coinIds: ['coinA'] }));
    expect(sw).toHaveBeenCalledWith(expect.objectContaining({ action: 'prepareSend', coinIds: ['coinA'] }), expect.any(Function));
  });

  it('revealPhrase returns the phrase on the right password and errors otherwise', async () => {
    mockSw((m) =>
      m.action === 'revealPhrase' && m.password === 'pw'
        ? { mnemonic: 'the phrase' }
        : { success: false, code: 'UNLOCK_FAILED' },
    );
    const store = createStore();
    const ok = await store.dispatch(custodyApi.endpoints.revealPhrase.initiate({ password: 'pw' }));
    expect(ok.data?.mnemonic).toBe('the phrase');
    const bad = await store.dispatch(custodyApi.endpoints.revealPhrase.initiate({ password: 'nope' }));
    expect(bad.error).toMatchObject({ code: 'UNLOCK_FAILED' });
  });

  // ── Multi-wallet switcher (#90) ──
  it('listWallets returns the record-free registry metadata + active id', async () => {
    mockSw((m) =>
      m.action === 'listWallets'
        ? {
            wallets: [
              { id: 'a', label: 'Wallet 1', createdAt: 1, active: false },
              { id: 'b', label: 'Trading', createdAt: 2, active: true },
            ],
            activeWalletId: 'b',
          }
        : { success: false },
    );
    const store = createStore();
    const res = await store.dispatch(custodyApi.endpoints.listWallets.initiate());
    expect(res.data?.activeWalletId).toBe('b');
    expect(res.data?.wallets).toHaveLength(2);
    // Metadata never carries the encrypted record.
    expect(res.data?.wallets[0]).not.toHaveProperty('record');
  });

  it('switchWallet to an unlocked wallet is instant (no password) and returns the active id', async () => {
    const sw = mockSw((m) => (m.action === 'switchWallet' ? { lockState: 'unlocked', activeWalletId: m.walletId } : {}));
    const store = createStore();
    const res = await store.dispatch(custodyApi.endpoints.switchWallet.initiate({ walletId: 'a' }));
    expect(res.data).toMatchObject({ lockState: 'unlocked', activeWalletId: 'a' });
    expect(sw).toHaveBeenCalledWith(expect.objectContaining({ action: 'switchWallet', walletId: 'a' }), expect.any(Function));
  });

  it('switchWallet to a locked wallet without a password surfaces NEEDS_UNLOCK', async () => {
    mockSw((m) =>
      m.action === 'switchWallet' && !m.password
        ? { success: false, code: 'NEEDS_UNLOCK', message: 'wallet locked' }
        : { lockState: 'unlocked', activeWalletId: m.walletId },
    );
    const store = createStore();
    const needs = await store.dispatch(custodyApi.endpoints.switchWallet.initiate({ walletId: 'c' }));
    expect(needs.error).toMatchObject({ code: 'NEEDS_UNLOCK' });
    // With the password it unlocks-then-activates.
    const ok = await store.dispatch(custodyApi.endpoints.switchWallet.initiate({ walletId: 'c', password: 'pw' }));
    expect(ok.data).toMatchObject({ activeWalletId: 'c' });
  });

  it('renameWallet forwards the label and returns the updated list', async () => {
    const sw = mockSw((m) =>
      m.action === 'renameWallet'
        ? { success: true, wallets: [{ id: 'a', label: m.label, createdAt: 1, active: true }], activeWalletId: 'a' }
        : {},
    );
    const store = createStore();
    const res = await store.dispatch(custodyApi.endpoints.renameWallet.initiate({ walletId: 'a', label: 'Savings' }));
    expect(res.data?.wallets[0].label).toBe('Savings');
    expect(sw).toHaveBeenCalledWith(expect.objectContaining({ action: 'renameWallet', walletId: 'a', label: 'Savings' }), expect.any(Function));
  });

  it('removeWallet returns the trimmed list, and refuses the last wallet with LAST_WALLET', async () => {
    mockSw((m) =>
      m.action === 'removeWallet' && m.walletId === 'b'
        ? { success: true, wallets: [{ id: 'a', label: 'Wallet 1', createdAt: 1, active: true }], activeWalletId: 'a', lockState: 'unlocked' }
        : { success: false, code: 'LAST_WALLET', message: 'cannot remove the last wallet' },
    );
    const store = createStore();
    const ok = await store.dispatch(custodyApi.endpoints.removeWallet.initiate({ walletId: 'b' }));
    expect(ok.data).toMatchObject({ activeWalletId: 'a', lockState: 'unlocked' });
    const last = await store.dispatch(custodyApi.endpoints.removeWallet.initiate({ walletId: 'only' }));
    expect(last.error).toMatchObject({ code: 'LAST_WALLET' });
  });
});
