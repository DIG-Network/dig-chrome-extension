import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

/** Tri-state custody lock state (mirrors `custody-session.mjs` LOCK_STATE). */
export type LockState = 'none' | 'locked' | 'unlocked';

/**
 * Cross-document self-custody client state (#56): the last-known lock state + active wallet id, so
 * the shell can render the state-driven landing matrix (no-wallet → unlock → home) synchronously
 * without awaiting a round-trip. The AUTHORITY is the SW (`getLockState`); this slice mirrors it —
 * refreshed by the `getLockState` query result, custody mutations, and the storage-sync bridge (the
 * non-secret `unlockExpiry` in `storage.session` changing on unlock/lock). NO secret is held here.
 */
export interface WalletState {
  lockState: LockState;
  activeWalletId: string | null;
  /** Non-secret unlock-expiry timestamp (ms) for a TTL countdown; never key material. */
  unlockExpiry: number | null;
}

function initialState(): WalletState {
  return { lockState: 'none', activeWalletId: null, unlockExpiry: null };
}

const walletSlice = createSlice({
  name: 'wallet',
  initialState: initialState(),
  reducers: {
    /** Merge an authoritative lock-state snapshot (from `getLockState` or a custody mutation). */
    custodyStateHydrated(
      state,
      action: PayloadAction<{ lockState?: LockState; activeWalletId?: string | null; unlockExpiry?: number | null }>,
    ) {
      const s = action.payload;
      if (!s) return;
      if (s.lockState) state.lockState = s.lockState;
      if ('activeWalletId' in s) state.activeWalletId = s.activeWalletId ?? null;
      if ('unlockExpiry' in s) state.unlockExpiry = s.unlockExpiry ?? null;
    },
    setLockState(state, action: PayloadAction<LockState>) {
      state.lockState = action.payload;
    },
    setActiveWallet(state, action: PayloadAction<string | null>) {
      state.activeWalletId = action.payload;
    },
  },
});

export const { custodyStateHydrated, setLockState, setActiveWallet } = walletSlice.actions;
export const walletReducer = walletSlice.reducer;

/** Selectors — a slice of `RootState.wallet`. Typed loosely to avoid a store import cycle. */
export const selectLockState = (s: { wallet: WalletState }): LockState => s.wallet.lockState;
export const selectIsUnlocked = (s: { wallet: WalletState }): boolean => s.wallet.lockState === 'unlocked';
export const selectHasWallet = (s: { wallet: WalletState }): boolean => s.wallet.lockState !== 'none';
export const selectActiveWalletId = (s: { wallet: WalletState }): string | null => s.wallet.activeWalletId;
