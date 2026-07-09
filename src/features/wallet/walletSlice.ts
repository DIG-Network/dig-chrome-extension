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
  /**
   * The active wallet's active HD derivation index (#165 — the single active-index model: one
   * index at a time, prev/next to switch). Default 0. Every wallet view (balance, assets, NFTs,
   * DIDs, activity, receive address) reflects ONLY this index.
   */
  activeIndex: number;
}

function initialState(): WalletState {
  return { lockState: 'none', activeWalletId: null, unlockExpiry: null, activeIndex: 0 };
}

const walletSlice = createSlice({
  name: 'wallet',
  initialState: initialState(),
  reducers: {
    /** Merge an authoritative lock-state snapshot (from `getLockState` or a custody mutation). */
    custodyStateHydrated(
      state,
      action: PayloadAction<{ lockState?: LockState; activeWalletId?: string | null; unlockExpiry?: number | null; activeIndex?: number }>,
    ) {
      const s = action.payload;
      if (!s) return;
      if (s.lockState) state.lockState = s.lockState;
      if ('activeWalletId' in s) state.activeWalletId = s.activeWalletId ?? null;
      if ('unlockExpiry' in s) state.unlockExpiry = s.unlockExpiry ?? null;
      if ('activeIndex' in s && s.activeIndex != null) state.activeIndex = s.activeIndex;
    },
    setLockState(state, action: PayloadAction<LockState>) {
      state.lockState = action.payload;
    },
    setActiveWallet(state, action: PayloadAction<string | null>) {
      state.activeWalletId = action.payload;
    },
    /** Optimistically set the active HD derivation index (#165) — reconciled by the next hydrate. */
    setActiveDerivationIndex(state, action: PayloadAction<number>) {
      state.activeIndex = action.payload;
    },
  },
});

export const { custodyStateHydrated, setLockState, setActiveWallet, setActiveDerivationIndex } = walletSlice.actions;
export const walletReducer = walletSlice.reducer;

/** Selectors — a slice of `RootState.wallet`. Typed loosely to avoid a store import cycle. */
export const selectLockState = (s: { wallet: WalletState }): LockState => s.wallet.lockState;
export const selectIsUnlocked = (s: { wallet: WalletState }): boolean => s.wallet.lockState === 'unlocked';
export const selectHasWallet = (s: { wallet: WalletState }): boolean => s.wallet.lockState !== 'none';
export const selectActiveWalletId = (s: { wallet: WalletState }): string | null => s.wallet.activeWalletId;
export const selectActiveDerivationIndex = (s: { wallet: WalletState }): number => s.wallet.activeIndex;
/** The non-secret unlock-expiry timestamp (ms), for the visible session countdown (#76). */
export const selectUnlockExpiry = (s: { wallet: WalletState }): number | null => s.wallet.unlockExpiry;
