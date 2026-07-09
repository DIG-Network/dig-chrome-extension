import { describe, it, expect } from 'vitest';
import {
  walletReducer,
  custodyStateHydrated,
  setLockState,
  setActiveWallet,
  setActiveDerivationIndex,
  selectLockState,
  selectIsUnlocked,
  selectHasWallet,
  selectActiveWalletId,
  selectActiveDerivationIndex,
  selectUnlockExpiry,
  type WalletState,
} from './walletSlice';

const initial = (): WalletState => walletReducer(undefined, { type: '@@INIT' });

describe('walletSlice', () => {
  it('defaults to no wallet, locked-none, no active id, active index 0', () => {
    const s = initial();
    expect(s.lockState).toBe('none');
    expect(s.activeWalletId).toBeNull();
    expect(s.unlockExpiry).toBeNull();
    expect(s.activeIndex).toBe(0);
  });

  it('custodyStateHydrated merges an authoritative snapshot', () => {
    const s = walletReducer(
      initial(),
      custodyStateHydrated({ lockState: 'unlocked', activeWalletId: 'w1', unlockExpiry: 999, activeIndex: 3 }),
    );
    expect(s.lockState).toBe('unlocked');
    expect(s.activeWalletId).toBe('w1');
    expect(s.unlockExpiry).toBe(999);
    expect(s.activeIndex).toBe(3);
  });

  it('custodyStateHydrated ignores an empty payload and partial fields', () => {
    const start: WalletState = { lockState: 'locked', activeWalletId: 'w1', unlockExpiry: 5, activeIndex: 2 };
    expect(walletReducer(start, custodyStateHydrated(undefined as never))).toEqual(start);
    const merged = walletReducer(start, custodyStateHydrated({ lockState: 'unlocked' }));
    expect(merged.lockState).toBe('unlocked');
    expect(merged.activeWalletId).toBe('w1'); // untouched
    expect(merged.activeIndex).toBe(2); // untouched
  });

  it('custodyStateHydrated can clear activeWalletId + unlockExpiry to null', () => {
    const start: WalletState = { lockState: 'locked', activeWalletId: 'w1', unlockExpiry: 5, activeIndex: 0 };
    const s = walletReducer(start, custodyStateHydrated({ activeWalletId: null, unlockExpiry: null }));
    expect(s.activeWalletId).toBeNull();
    expect(s.unlockExpiry).toBeNull();
  });

  it('custodyStateHydrated can update activeIndex on its own (index navigation, #165)', () => {
    const start: WalletState = { lockState: 'unlocked', activeWalletId: 'w1', unlockExpiry: 5, activeIndex: 0 };
    const s = walletReducer(start, custodyStateHydrated({ activeIndex: 4 }));
    expect(s.activeIndex).toBe(4);
    expect(s.lockState).toBe('unlocked'); // untouched
  });

  it('setLockState + setActiveWallet update their fields', () => {
    let s = walletReducer(initial(), setLockState('locked'));
    expect(s.lockState).toBe('locked');
    s = walletReducer(s, setActiveWallet('w2'));
    expect(s.activeWalletId).toBe('w2');
    s = walletReducer(s, setActiveWallet(null));
    expect(s.activeWalletId).toBeNull();
  });

  it('setActiveDerivationIndex updates the active index (#165)', () => {
    let s = walletReducer(initial(), setActiveDerivationIndex(5));
    expect(s.activeIndex).toBe(5);
    s = walletReducer(s, setActiveDerivationIndex(0));
    expect(s.activeIndex).toBe(0);
  });

  it('selectors read the slice', () => {
    const root = { wallet: { lockState: 'unlocked', activeWalletId: 'w1', unlockExpiry: 1, activeIndex: 2 } as WalletState };
    expect(selectLockState(root)).toBe('unlocked');
    expect(selectIsUnlocked(root)).toBe(true);
    expect(selectHasWallet(root)).toBe(true);
    expect(selectActiveWalletId(root)).toBe('w1');
    expect(selectActiveDerivationIndex(root)).toBe(2);
    expect(selectUnlockExpiry(root)).toBe(1);
    const none = { wallet: { lockState: 'none', activeWalletId: null, unlockExpiry: null, activeIndex: 0 } as WalletState };
    expect(selectIsUnlocked(none)).toBe(false);
    expect(selectHasWallet(none)).toBe(false);
    expect(selectUnlockExpiry(none)).toBeNull();
  });
});
