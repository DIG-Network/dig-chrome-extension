import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { Provider } from 'react-redux';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createStore, type AppStore } from '@/app/store';
import { custodyApi } from '@/features/wallet/custodyApi';
import { useBackgroundPrefetch } from '@/app/useBackgroundPrefetch';

/** Route SW messages by action, like custodyApi.test.ts's `mockSw` — a reply may itself be a Promise
 * so a test can model a real round-trip delay for exactly the call it cares about. */
function mockSw(router: (msg: { action: string; [k: string]: unknown }) => unknown) {
  const fn = vi.fn((msg: unknown, cb?: (r: unknown) => void) => {
    const result = router(msg as { action: string; [k: string]: unknown });
    void Promise.resolve(result).then((reply) => cb?.(reply));
    return Promise.resolve(result);
  });
  (chrome.runtime as unknown as { sendMessage: typeof fn }).sendMessage = fn;
  return fn;
}

function actionsOf(fn: ReturnType<typeof mockSw>): string[] {
  return fn.mock.calls.map((c) => (c[0] as { action: string }).action);
}

function wrapper(store: AppStore) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <Provider store={store}>{children}</Provider>;
  };
}

afterEach(() => vi.restoreAllMocks());

describe('useBackgroundPrefetch (#168 — SW/background warms the cache on unlock, not lazy on nav)', () => {
  it('fires balances, collectibles, and activity as soon as the wallet is unlocked — no view needs to mount them', async () => {
    const sw = mockSw((m) => {
      if (m.action === 'getLockState') return { lockState: 'unlocked', activeWalletId: 'w1', activeIndex: 0 };
      if (m.action === 'getCustodyBalances') return { balances: { xch: 1, cats: {} } };
      if (m.action === 'listNfts') return { nfts: [] };
      if (m.action === 'getActivity') return { events: [] };
      return { success: true };
    });
    const store = createStore();

    renderHook(() => useBackgroundPrefetch(), { wrapper: wrapper(store) });

    await waitFor(() => {
      const actions = actionsOf(sw);
      expect(actions).toContain('getCustodyBalances');
      expect(actions).toContain('listNfts');
      expect(actions).toContain('getActivity');
    });

    // Single-index scope (#165): exactly one round per endpoint — never a multi-index sweep.
    expect(actionsOf(sw).filter((a) => a === 'getCustodyBalances')).toHaveLength(1);
    expect(actionsOf(sw).filter((a) => a === 'listNfts')).toHaveLength(1);
    expect(actionsOf(sw).filter((a) => a === 'getActivity')).toHaveLength(1);
  });

  it('never prefetches while locked / before a wallet exists', async () => {
    const sw = mockSw((m) => (m.action === 'getLockState' ? { lockState: 'locked' } : { success: true }));
    const store = createStore();

    renderHook(() => useBackgroundPrefetch(), { wrapper: wrapper(store) });

    await waitFor(() => expect(actionsOf(sw)).toContain('getLockState'));
    await new Promise((r) => setTimeout(r, 0));
    expect(actionsOf(sw)).not.toContain('getCustodyBalances');
    expect(actionsOf(sw)).not.toContain('listNfts');
  });

  it('does not re-fire for the same wallet+index on a re-render (dedupe)', async () => {
    const sw = mockSw((m) => {
      if (m.action === 'getLockState') return { lockState: 'unlocked', activeWalletId: 'w1', activeIndex: 0 };
      return { success: true };
    });
    const store = createStore();

    const { rerender } = renderHook(() => useBackgroundPrefetch(), { wrapper: wrapper(store) });
    await waitFor(() => expect(actionsOf(sw)).toContain('getCustodyBalances'));
    const countAfterFirstRound = sw.mock.calls.length;

    rerender();
    rerender();
    await new Promise((r) => setTimeout(r, 0));

    expect(sw.mock.calls.length).toBe(countAfterFirstRound);
  });

  it('re-prefetches on an active-index switch and the cache ends up reflecting ONLY the new index (no stale write)', async () => {
    let activeIndex = 0;
    let releaseIndex0Balances: ((v: unknown) => void) | undefined;
    const sw = mockSw((m) => {
      if (m.action === 'getLockState') return { lockState: 'unlocked', activeWalletId: 'w1', activeIndex };
      if (m.action === 'getCustodyBalances') {
        if (activeIndex === 0) {
          // Model a slow index-0 round-trip still in flight when the switch happens.
          return new Promise((resolve) => {
            releaseIndex0Balances = resolve;
          });
        }
        return { balances: { xch: 222, cats: {} } };
      }
      if (m.action === 'setActiveIndex') {
        activeIndex = 1;
        return { success: true, activeIndex: 1 };
      }
      return { success: true };
    });
    const store = createStore();

    renderHook(() => useBackgroundPrefetch(), { wrapper: wrapper(store) });

    // The index-0 round starts (balances call in flight, unresolved).
    await waitFor(() => expect(actionsOf(sw)).toContain('getCustodyBalances'));
    const firstRoundBalanceCalls = actionsOf(sw).filter((a) => a === 'getCustodyBalances').length;
    expect(firstRoundBalanceCalls).toBe(1);

    // Switch index BEFORE the stale index-0 balances call resolves — this mutation's own
    // `resetCacheOnIdentityChange` wipes the whole api cache on success (custodyApi.ts).
    await act(async () => {
      await store.dispatch(custodyApi.endpoints.setActiveIndex.initiate({ index: 1 }));
    });

    // NOW resolve the stale index-0 fetch late — it must never land as index 1's data.
    await act(async () => {
      releaseIndex0Balances?.({ balances: { xch: 111, cats: {} } });
      await Promise.resolve();
    });

    // A fresh round re-fires for index 1 (re-prefetch on switch).
    await waitFor(() => {
      const calls = actionsOf(sw).filter((a) => a === 'getCustodyBalances');
      expect(calls.length).toBeGreaterThanOrEqual(2);
    });

    await waitFor(() => {
      const cached = custodyApi.endpoints.getCustodyBalances.select()(store.getState());
      expect(cached.data?.balances.xch).toBe(222);
    });
  });
});
