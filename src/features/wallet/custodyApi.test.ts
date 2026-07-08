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

  it('prepareSend forwards an optional memo and returns the decoded memoText (#105)', async () => {
    const sw = mockSw((m) =>
      m.action === 'prepareSend'
        ? { pendingId: 'p4', summary: { asset: 'XCH', sent: '1', change: '0', fee: '0', recipientPuzzleHashHex: 'ab', coinCount: 1, memoText: 'thanks!' } }
        : {},
    );
    const store = createStore();
    const res = await store.dispatch(custodyApi.endpoints.prepareSend.initiate({ recipient: 'xch1r', amount: '1', memo: 'thanks!' }));
    expect(sw).toHaveBeenCalledWith(expect.objectContaining({ action: 'prepareSend', memo: 'thanks!' }), expect.any(Function));
    expect(res.data?.summary.memoText).toBe('thanks!');
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

  // ── Single active derivation index (#165) ──
  it('getLockState carries the active wallet\'s active derivation index', async () => {
    mockSw((m) => (m.action === 'getLockState' ? { lockState: 'unlocked', activeWalletId: 'a', activeIndex: 3 } : { success: false }));
    const store = createStore();
    const res = await store.dispatch(custodyApi.endpoints.getLockState.initiate());
    expect(res.data?.activeIndex).toBe(3);
  });

  it('setActiveIndex sends the target index and returns the persisted active index', async () => {
    const sw = mockSw((m) => (m.action === 'setActiveIndex' ? { success: true, activeIndex: m.index } : { success: false }));
    const store = createStore();
    const res = await store.dispatch(custodyApi.endpoints.setActiveIndex.initiate({ index: 2 }));
    expect(res.data).toMatchObject({ activeIndex: 2 });
    expect(sw).toHaveBeenCalledWith(expect.objectContaining({ action: 'setActiveIndex', index: 2 }), expect.any(Function));
  });

  it('setActiveIndex surfaces NO_WALLET as an RTK Query error', async () => {
    mockSw((m) => (m.action === 'setActiveIndex' ? { success: false, code: 'NO_WALLET', message: 'no wallet' } : {}));
    const store = createStore();
    const res = await store.dispatch(custodyApi.endpoints.setActiveIndex.initiate({ index: 1 }));
    expect(res.error).toMatchObject({ code: 'NO_WALLET' });
  });

  // ── #162: switching the active wallet/index must clear stale wallet-scoped cache, not just
  // invalidate it. `invalidatesTags` alone schedules a background refetch but keeps SERVING the
  // previous identity's cached value (`isLoading` stays false) until the refetch resolves — the exact
  // bug reported (the previous wallet's balances/activity/etc. linger on screen after a switch). A
  // CONFIRMED identity change must wipe the whole cache so every wallet-scoped view falls back to its
  // loading state instead. A FAILED attempt (e.g. NEEDS_UNLOCK) must leave the cache untouched — the
  // active identity never changed.
  describe('#162 active-identity change resets the whole wallet-scoped cache', () => {
    function seedBalancesCache(store: ReturnType<typeof createStore>) {
      return store.dispatch(custodyApi.endpoints.getCustodyBalances.initiate());
    }
    function balancesCacheStatus(store: ReturnType<typeof createStore>) {
      return custodyApi.endpoints.getCustodyBalances.select()(store.getState());
    }

    it('a successful switchWallet wipes the cache — the old wallet balances entry goes uninitialized', async () => {
      mockSw((m) => {
        if (m.action === 'getCustodyBalances') return { balances: { xch: 111, cats: {} } };
        if (m.action === 'switchWallet') return { lockState: 'unlocked', activeWalletId: m.walletId };
        return { success: false };
      });
      const store = createStore();
      await seedBalancesCache(store);
      expect(balancesCacheStatus(store).data).toMatchObject({ balances: { xch: 111 } });

      await store.dispatch(custodyApi.endpoints.switchWallet.initiate({ walletId: 'b' }));

      const after = balancesCacheStatus(store);
      expect(after.status).toBe('uninitialized');
      expect(after.data).toBeUndefined();
    });

    it('a switchWallet that needs unlock (fails) leaves the cache untouched', async () => {
      mockSw((m) => {
        if (m.action === 'getCustodyBalances') return { balances: { xch: 222, cats: {} } };
        if (m.action === 'switchWallet') return { success: false, code: 'NEEDS_UNLOCK' };
        return { success: false };
      });
      const store = createStore();
      await seedBalancesCache(store);

      await store.dispatch(custodyApi.endpoints.switchWallet.initiate({ walletId: 'locked-wallet' }));

      expect(balancesCacheStatus(store).data).toMatchObject({ balances: { xch: 222 } });
    });

    it('a successful setActiveIndex also wipes the cache (#165 coordination)', async () => {
      mockSw((m) => {
        if (m.action === 'getCustodyBalances') return { balances: { xch: 333, cats: {} } };
        if (m.action === 'setActiveIndex') return { success: true, activeIndex: m.index };
        return { success: false };
      });
      const store = createStore();
      await seedBalancesCache(store);

      await store.dispatch(custodyApi.endpoints.setActiveIndex.initiate({ index: 2 }));

      expect(balancesCacheStatus(store).status).toBe('uninitialized');
    });

    it('a setActiveIndex failure (NO_WALLET) leaves the cache untouched', async () => {
      mockSw((m) => {
        if (m.action === 'getCustodyBalances') return { balances: { xch: 444, cats: {} } };
        if (m.action === 'setActiveIndex') return { success: false, code: 'NO_WALLET' };
        return { success: false };
      });
      const store = createStore();
      await seedBalancesCache(store);

      await store.dispatch(custodyApi.endpoints.setActiveIndex.initiate({ index: 9 }));

      expect(balancesCacheStatus(store).data).toMatchObject({ balances: { xch: 444 } });
    });

    it('removeWallet re-homing the active wallet also wipes the cache', async () => {
      mockSw((m) => {
        if (m.action === 'getCustodyBalances') return { balances: { xch: 555, cats: {} } };
        if (m.action === 'removeWallet') {
          return { success: true, wallets: [{ id: 'a', label: 'Wallet 1', createdAt: 1, active: true }], activeWalletId: 'a', lockState: 'unlocked' };
        }
        return { success: false };
      });
      const store = createStore();
      await seedBalancesCache(store);

      await store.dispatch(custodyApi.endpoints.removeWallet.initiate({ walletId: 'b' }));

      expect(balancesCacheStatus(store).status).toBe('uninitialized');
    });

    it('removeWallet refused (LAST_WALLET) leaves the cache untouched', async () => {
      mockSw((m) => {
        if (m.action === 'getCustodyBalances') return { balances: { xch: 666, cats: {} } };
        if (m.action === 'removeWallet') return { success: false, code: 'LAST_WALLET' };
        return { success: false };
      });
      const store = createStore();
      await seedBalancesCache(store);

      await store.dispatch(custodyApi.endpoints.removeWallet.initiate({ walletId: 'only' }));

      expect(balancesCacheStatus(store).data).toMatchObject({ balances: { xch: 666 } });
    });

    it('createWallet (adding a wallet while one is already active) wipes the cache', async () => {
      mockSw((m) => {
        if (m.action === 'getCustodyBalances') return { balances: { xch: 777, cats: {} } };
        if (m.action === 'createWallet') return { lockState: 'unlocked', mnemonic: 'word '.repeat(24).trim() };
        return { success: false };
      });
      const store = createStore();
      await seedBalancesCache(store);

      await store.dispatch(custodyApi.endpoints.createWallet.initiate({ password: 'pw' }));

      expect(balancesCacheStatus(store).status).toBe('uninitialized');
    });

    it('importWallet (adding a wallet while one is already active) wipes the cache', async () => {
      mockSw((m) => {
        if (m.action === 'getCustodyBalances') return { balances: { xch: 888, cats: {} } };
        if (m.action === 'importWallet') return { lockState: 'unlocked' };
        return { success: false };
      });
      const store = createStore();
      await seedBalancesCache(store);

      await store.dispatch(custodyApi.endpoints.importWallet.initiate({ mnemonic: 'abandon art', password: 'pw' }));

      expect(balancesCacheStatus(store).status).toBe('uninitialized');
    });
  });
});
