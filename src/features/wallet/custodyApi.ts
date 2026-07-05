import { api } from '@/api/api';
import { ACTIONS } from '#shared/messages.mjs';
import type { LockState } from '@/features/wallet/walletSlice';
import type { ActivityEvent } from '@/offscreen/activity';
import type { WireOfferLeg, WireOfferSummary } from '@/offscreen/vault';

/**
 * Self-custody endpoints (#56) — these route over the SW seam (`chromeBaseQuery` →
 * `chrome.runtime.sendMessage` → the background SW → the offscreen keystore vault). The decrypted
 * key never crosses this boundary; requests carry the password IN and public lock-state / the
 * once-shown mnemonic OUT. Split from `walletApi` (which brokers Sage over WalletConnect) because
 * custody is a distinct backend; both inject into the single `api` slice.
 */

export interface LockStateResult {
  lockState: LockState;
  activeWalletId?: string | null;
  unlockExpiry?: number | null;
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

export const custodyApi = api.injectEndpoints({
  endpoints: (build) => ({
    getLockState: build.query<LockStateResult, void>({
      query: () => ({ action: ACTIONS.getLockState }),
      providesTags: ['LockState'],
    }),

    createWallet: build.mutation<CreateWalletResult, { password: string; label?: string; strong?: boolean }>({
      query: (arg) => ({ action: ACTIONS.createWallet, ...arg }),
      invalidatesTags: ['LockState', 'Balances', 'Activity', 'Address'],
    }),

    importWallet: build.mutation<
      UnlockResult,
      { mnemonic: string; password: string; label?: string; strong?: boolean }
    >({
      query: (arg) => ({ action: ACTIONS.importWallet, ...arg }),
      invalidatesTags: ['LockState', 'Balances', 'Activity', 'Address'],
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

    // Build (not broadcast) a send → returns the decoded summary to approve.
    prepareSend: build.mutation<PreparedSend, { recipient: string; amount: string; fee?: string }>({
      query: (arg) => ({ action: ACTIONS.prepareSend, ...arg }),
    }),
    // Sign + BROADCAST a prepared send (the approved step). Invalidates balances/activity.
    confirmSend: build.mutation<{ spentCoinId: string }, { pendingId: string }>({
      query: (arg) => ({ action: ACTIONS.confirmSend, ...arg }),
      invalidatesTags: ['Balances', 'Activity'],
    }),
    // Poll whether a broadcast send has confirmed.
    sendStatus: build.query<{ confirmed: boolean }, { coinId: string }>({
      query: (arg) => ({ action: ACTIONS.sendStatus, ...arg }),
    }),

    // Reconstruct the transaction ledger (read-only). Named distinctly from walletApi's Sage
    // `getActivity` to avoid an endpoint-name collision on the shared api slice. Cached-first via SW.
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
  useUnlockWalletMutation,
  useLockWalletMutation,
  useRevealPhraseMutation,
  useGetReceiveAddressQuery,
  useGetCustodyBalancesQuery,
  usePrepareSendMutation,
  useConfirmSendMutation,
  useLazySendStatusQuery,
  useGetCustodyActivityQuery,
  useMakeCustodyOfferMutation,
  useInspectCustodyOfferMutation,
  usePrepareTradeMutation,
  useConfirmTradeMutation,
} = custodyApi;
