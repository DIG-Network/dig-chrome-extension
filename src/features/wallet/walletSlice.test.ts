import { describe, it, expect } from 'vitest';
import {
  walletReducer,
  custodyStateHydrated,
  setLockState,
  setActiveWallet,
  selectLockState,
  selectIsUnlocked,
  selectHasWallet,
  selectActiveWalletId,
  type WalletState,
} from './walletSlice';

const initial = (): WalletState => walletReducer(undefined, { type: '@@INIT' });

describe('walletSlice', () => {
  it('defaults to no wallet, locked-none, no active id', () => {
    const s = initial();
    expect(s.lockState).toBe('none');
    expect(s.activeWalletId).toBeNull();
    expect(s.unlockExpiry).toBeNull();
  });

  it('custodyStateHydrated merges an authoritative snapshot', () => {
    const s = walletReducer(initial(), custodyStateHydrated({ lockState: 'unlocked', activeWalletId: 'w1', unlockExpiry: 999 }));
    expect(s.lockState).toBe('unlocked');
    expect(s.activeWalletId).toBe('w1');
    expect(s.unlockExpiry).toBe(999);
  });

  it('custodyStateHydrated ignores an empty payload and partial fields', () => {
    const start: WalletState = { lockState: 'locked', activeWalletId: 'w1', unlockExpiry: 5 };
    expect(walletReducer(start, custodyStateHydrated(undefined as never))).toEqual(start);
    const merged = walletReducer(start, custodyStateHydrated({ lockState: 'unlocked' }));
    expect(merged.lockState).toBe('unlocked');
    expect(merged.activeWalletId).toBe('w1'); // untouched
  });

  it('custodyStateHydrated can clear activeWalletId + unlockExpiry to null', () => {
    const start: WalletState = { lockState: 'locked', activeWalletId: 'w1', unlockExpiry: 5 };
    const s = walletReducer(start, custodyStateHydrated({ activeWalletId: null, unlockExpiry: null }));
    expect(s.activeWalletId).toBeNull();
    expect(s.unlockExpiry).toBeNull();
  });

  it('setLockState + setActiveWallet update their fields', () => {
    let s = walletReducer(initial(), setLockState('locked'));
    expect(s.lockState).toBe('locked');
    s = walletReducer(s, setActiveWallet('w2'));
    expect(s.activeWalletId).toBe('w2');
    s = walletReducer(s, setActiveWallet(null));
    expect(s.activeWalletId).toBeNull();
  });

  it('selectors read the slice', () => {
    const root = { wallet: { lockState: 'unlocked', activeWalletId: 'w1', unlockExpiry: 1 } as WalletState };
    expect(selectLockState(root)).toBe('unlocked');
    expect(selectIsUnlocked(root)).toBe(true);
    expect(selectHasWallet(root)).toBe(true);
    expect(selectActiveWalletId(root)).toBe('w1');
    const none = { wallet: { lockState: 'none', activeWalletId: null, unlockExpiry: null } as WalletState };
    expect(selectIsUnlocked(none)).toBe(false);
    expect(selectHasWallet(none)).toBe(false);
  });
});
