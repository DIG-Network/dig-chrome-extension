import { api } from '@/api/api';
import { ACTIONS } from '@/lib/messages';
import type { LockState } from '@/features/wallet/walletSlice';
import type { ActivityEvent } from '@/offscreen/activity';
import type { WireOfferLeg, WireOfferSummary } from '@/offscreen/vault';
import type { WalletMeta } from '@/lib/wallet-registry';

/** The record-free registry snapshot the switcher reads (#90): every wallet's metadata + the active id. */
export interface WalletsResult {
  wallets: WalletMeta[];
  activeWalletId: string | null;
}
/** The reply from a registry mutation (rename / remove): the updated metadata list + active id. */
export interface WalletsMutationResult {
  wallets: WalletMeta[];
  activeWalletId: string | null;
  /** removeWallet only: `locked` when re-homing the active wallet landed on one not unlocked this session. */
  lockState?: LockState;
}

/**
 * Self-custody endpoints (#56) — the ONLY wallet backend (the extension holds its own key; there is
 * no WalletConnect/Sage broker). These route over the SW seam (`chromeBaseQuery` →
 * `chrome.runtime.sendMessage` → the background SW → the offscreen keystore vault). The decrypted
 * key never crosses this boundary; requests carry the password IN and public lock-state / the
 * once-shown mnemonic OUT. Injects into the single `api` slice.
 */

export interface LockStateResult {
  lockState: LockState;
  activeWalletId?: string | null;
  unlockExpiry?: number | null;
  /** The active wallet's active HD derivation index (#165 — the single active-index model). */
  activeIndex?: number;
}
export interface CreateWalletResult {
  lockState: LockState;
  /** The 24-word recovery phrase — shown ONCE for backup, never stored. */
  mnemonic: string;
  address?: string;
  usedFallback?: boolean;
}
export interface UnlockResult {
  lockState: LockState;
  usedFallback?: boolean;
}
export interface RevealResult {
  mnemonic: string;
}
/** A scanned balance snapshot (base units): XCH mojos + per-CAT (asset id → base units). */
export interface CustodyBalances {
  balances: { xch: number; cats: Record<string, number> };
  /** True when this is the last cached snapshot returned because a fresh scan failed. */
  cached?: boolean;
}
/** A prepared (unsigned) send: the pending id + the decoded summary to approve. */
export interface PreparedSend {
  pendingId: string;
  summary: { asset: string; sent: string; change: string; fee: string; recipientPuzzleHashHex: string; coinCount: number };
}
/** One listed unspent coin (coin control #91): id (hex) + amount (base units) + confirmed height. */
export interface WalletCoin {
  coinId: string;
  amount: string;
  confirmedHeight: number;
}
/** A prepared (unsigned) split/combine: the pending id + the decoded, self-send-verified summary. */
export interface PreparedCoinOp {
  pendingId: string;
  coinOpSummary: { asset: string; kind: 'split' | 'combine'; inputCoinCount: number; outputCoinCount: number; total: string; fee: string };
}

/**
 * The cache tags to invalidate whenever the ACTIVE wallet changes (create / import / switch / remove
 * an active wallet): every wallet-derived view — the registry list, lock state, balances, activity,
 * receive address, collectibles, and the coin list — must re-read for the newly-active wallet.
 */
const ACTIVE_WALLET_INVALIDATION = ['Wallets', 'LockState', 'Balances', 'Activity', 'Address', 'Collectibles', 'Coins'] as const;

/**
 * The cache tags to invalidate when the active HD derivation index changes (#165 — prev/next/jump).
 * Same set as a wallet switch minus `Wallets` (the wallet identity itself is unchanged) — every
 * index-scoped view (balances, activity, receive address, collectibles, coins) must re-read for the
 * newly-active index. `LockState` is included because it carries `activeIndex` (§165 hydration).
 */
const ACTIVE_INDEX_INVALIDATION = ['LockState', 'Balances', 'Activity', 'Address', 'Collectibles', 'Coins'] as const;

export const custodyApi = api.injectEndpoints({
  endpoints: (build) => ({
    getLockState: build.query<LockStateResult, void>({
      query: () => ({ action: ACTIONS.getLockState }),
      providesTags: ['LockState'],
    }),

    createWallet: build.mutation<CreateWalletResult, { password: string; label?: string; strong?: boolean }>({
      query: (arg) => ({ action: ACTIONS.createWallet, ...arg }),
      invalidatesTags: ACTIVE_WALLET_INVALIDATION,
    }),

    importWallet: build.mutation<
      UnlockResult,
      { mnemonic: string; password: string; label?: string; strong?: boolean }
    >({
      query: (arg) => ({ action: ACTIONS.importWallet, ...arg }),
      invalidatesTags: ACTIVE_WALLET_INVALIDATION,
    }),

    // ── Multi-wallet switcher (#90) ──
    // The registry snapshot: record-free metadata for every wallet + the active id.
    listWallets: build.query<WalletsResult, void>({
      query: () => ({ action: ACTIONS.listWallets }),
      providesTags: ['Wallets'],
    }),
    // Activate another wallet. Instant when its key is cached this session; with a password it
    // unlocks-then-activates; without one for a not-yet-unlocked wallet it errors NEEDS_UNLOCK so the
    // switcher prompts. Everything wallet-derived is invalidated so the whole UI re-reads the new wallet.
    switchWallet: build.mutation<{ lockState: LockState; activeWalletId: string }, { walletId: string; password?: string }>({
      query: (arg) => ({ action: ACTIONS.switchWallet, ...arg }),
      invalidatesTags: ACTIVE_WALLET_INVALIDATION,
    }),
    // Rename one wallet (metadata only — no key, no password). Only the registry list changes.
    renameWallet: build.mutation<WalletsMutationResult, { walletId: string; label: string }>({
      query: (arg) => ({ action: ACTIONS.renameWallet, ...arg }),
      invalidatesTags: ['Wallets'],
    }),
    // Remove one wallet (zeroizes its cached key); refuses the last (LAST_WALLET). Removing the active
    // one re-homes active, so invalidate the full wallet-derived set alongside the registry list.
    removeWallet: build.mutation<WalletsMutationResult, { walletId: string }>({
      query: (arg) => ({ action: ACTIONS.removeWallet, ...arg }),
      invalidatesTags: ACTIVE_WALLET_INVALIDATION,
    }),

    // ── Single active derivation index (#165) ──
    // Navigate the active wallet's active HD derivation index (prev/next/jump — the caller computes
    // the absolute target index). Every index-scoped view re-reads for the newly-active index.
    setActiveIndex: build.mutation<{ activeIndex: number }, { index: number }>({
      query: (arg) => ({ action: ACTIONS.setActiveIndex, ...arg }),
      invalidatesTags: ACTIVE_INDEX_INVALIDATION,
    }),

    unlockWallet: build.mutation<UnlockResult, { password: string }>({
      query: (arg) => ({ action: ACTIONS.unlockWallet, ...arg }),
      invalidatesTags: ['LockState', 'Balances', 'Activity', 'Address'],
    }),

    lockWallet: build.mutation<{ lockState: LockState }, void>({
      query: () => ({ action: ACTIONS.lockWallet }),
      invalidatesTags: ['LockState', 'Balances', 'Activity', 'Address'],
    }),

    // A mutation (not a cached query) so the sensitive phrase is never retained in the query cache.
    revealPhrase: build.mutation<RevealResult, { password: string }>({
      query: (arg) => ({ action: ACTIONS.revealPhrase, ...arg }),
    }),

    getReceiveAddress: build.query<{ address: string }, void>({
      query: () => ({ action: ACTIONS.getReceiveAddress }),
      providesTags: ['Address'],
    }),

    getCustodyBalances: build.query<CustodyBalances, void>({
      query: () => ({ action: ACTIONS.getCustodyBalances }),
      providesTags: ['Balances'],
    }),

    // Build (not broadcast) a send → returns the decoded summary to approve. An optional `assetId`
    // routes a CAT send (#121); an optional `coinIds` hand-picks the funding coins (#91).
    prepareSend: build.mutation<PreparedSend, { recipient: string; amount: string; fee?: string; assetId?: string; coinIds?: string[] }>({
      query: (arg) => ({ action: ACTIONS.prepareSend, ...arg }),
    }),
    // Sign + BROADCAST a prepared send / split / combine (the approved step). Invalidates the caches.
    confirmSend: build.mutation<{ spentCoinId: string }, { pendingId: string }>({
      query: (arg) => ({ action: ACTIONS.confirmSend, ...arg }),
      invalidatesTags: ['Balances', 'Activity', 'Coins'],
    }),

    // ── Coin control (#91) ──
    // List the wallet's unspent coins for one asset (id + amount + confirmed height). Routed on assetId.
    getCoins: build.query<{ coins: WalletCoin[] }, { assetId?: string }>({
      query: (arg) => ({ action: ACTIONS.listCoins, ...(arg.assetId ? { assetId: arg.assetId } : {}) }),
      providesTags: ['Coins'],
    }),
    // Build (not broadcast) a split → held under a pending id; confirmed via confirmSend.
    prepareSplit: build.mutation<PreparedCoinOp, { coinIds: string[]; outputs: number; fee?: string; assetId?: string }>({
      query: (arg) => ({ action: ACTIONS.prepareSplit, ...arg }),
    }),
    // Build (not broadcast) a combine → held under a pending id; confirmed via confirmSend.
    prepareCombine: build.mutation<PreparedCoinOp, { coinIds: string[]; fee?: string; assetId?: string }>({
      query: (arg) => ({ action: ACTIONS.prepareCombine, ...arg }),
    }),
    // Poll whether a broadcast send has confirmed.
    sendStatus: build.query<{ confirmed: boolean }, { coinId: string }>({
      query: (arg) => ({ action: ACTIONS.sendStatus, ...arg }),
    }),

    // Reconstruct the transaction ledger (read-only) from the offscreen vault. Cached-first via SW.
    getCustodyActivity: build.query<{ events: ActivityEvent[]; cursorHeight: number; cached?: boolean }, void>({
      query: () => ({ action: ACTIONS.getActivity }),
      providesTags: ['Activity'],
    }),

    // ── Trade offers (#56) ──
    // Build (not broadcast) a shareable offer → the `offer1…` string + two-sided summary.
    makeCustodyOffer: build.mutation<{ offer: string; offerSummary: WireOfferSummary }, { offered: WireOfferLeg; requested: WireOfferLeg; fee?: string }>({
      query: (arg) => ({ action: ACTIONS.makeOffer, ...arg }),
    }),
    // Decode an offer string → its two-sided summary (read-only review).
    inspectCustodyOffer: build.mutation<{ offerSummary: WireOfferSummary }, { offerStr: string }>({
      query: (arg) => ({ action: ACTIONS.inspectOffer, ...arg }),
    }),
    // Build + sign (not broadcast) a take/cancel → held under a pending id + summary to approve.
    prepareTrade: build.mutation<{ pendingId: string; offerSummary: WireOfferSummary }, { offerStr: string; tradeKind: 'take' | 'cancel'; fee?: string }>({
      query: (arg) => ({ action: ACTIONS.prepareTrade, ...arg }),
    }),
    // BROADCAST a prepared trade (the approved step). Invalidates balances/activity.
    confirmTrade: build.mutation<{ spentCoinId: string }, { pendingId: string }>({
      query: (arg) => ({ action: ACTIONS.confirmTrade, ...arg }),
      invalidatesTags: ['Balances', 'Activity'],
    }),
  }),
  overrideExisting: false,
});

export const {
  useGetLockStateQuery,
  useCreateWalletMutation,
  useImportWalletMutation,
  useListWalletsQuery,
  useSwitchWalletMutation,
  useRenameWalletMutation,
  useRemoveWalletMutation,
  useSetActiveIndexMutation,
  useUnlockWalletMutation,
  useLockWalletMutation,
  useRevealPhraseMutation,
  useGetReceiveAddressQuery,
  useGetCustodyBalancesQuery,
  usePrepareSendMutation,
  useConfirmSendMutation,
  useLazySendStatusQuery,
  useGetCoinsQuery,
  usePrepareSplitMutation,
  usePrepareCombineMutation,
  useGetCustodyActivityQuery,
  useMakeCustodyOfferMutation,
  useInspectCustodyOfferMutation,
  usePrepareTradeMutation,
  useConfirmTradeMutation,
} = custodyApi;
