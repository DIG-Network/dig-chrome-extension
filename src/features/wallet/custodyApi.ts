import type { ThunkDispatch, UnknownAction } from '@reduxjs/toolkit';
import { api } from '@/api/api';
import { ACTIONS } from '@/lib/messages';
import type { LockState } from '@/features/wallet/walletSlice';
import type { LocalActivityEntry } from '@/lib/activity-log';
import type { OfferLogEntry } from '@/lib/offer-log';
import type { DexieOfferSummary } from '@/lib/dexie';
import type { WireOfferLeg, WireOfferSummary, WireCatIssuanceParams, WireOptionMintParams } from '@/offscreen/vault';
import type { CatIssuanceSummary } from '@/offscreen/catIssuance';
import type { OptionRecord, OptionMintSummary, OptionExerciseSummary } from '@/offscreen/optionContracts';
import type { OptionLogEntry } from '@/lib/optionContractLog';
import type { AccountEntry, WalletMeta } from '@/lib/wallet-registry';

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
/** One derived address (#106) — a display-only row (index + scheme + address), no key material. */
export interface DerivedAddress {
  index: number;
  scheme: 'unhardened' | 'hardened';
  address: string;
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
/** Private-key reveal (#96): the raw account secret key at the active index, one entry per scheme. */
export interface ExportPrivateKeyResult {
  privateKeys: { scheme: 'unhardened' | 'hardened'; hex: string }[];
}
/** Watch-only import (#96): the new wallet's id + its previewed index-0 address + key fingerprint. */
export interface ImportWatchResult {
  activeWalletId: string;
  address: string;
  fingerprint: number;
}
/** The reply from an account mutation (#95 add/rename/remove): the active wallet's updated accounts. */
export interface AccountsResult {
  accounts: AccountEntry[];
}
/** Keystore file backup export (#115): the download filename + the JSON envelope text. */
export interface ExportBackupResult {
  filename: string;
  json: string;
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
  summary: {
    asset: string;
    sent: string;
    change: string;
    fee: string;
    recipientPuzzleHashHex: string;
    coinCount: number;
    /** #105 — the plain-text memo attached to the send, decoded back from the built spend; absent
     * when no memo was sent. */
    memoText?: string;
  };
  /** #152 — present iff sent WITH a clawback window; persist it (the local activity log carries it
   * automatically once confirmed) so the pending clawback can later be listed/claimed/clawed back. */
  clawbackInfo?: WireClawbackInfo;
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
/** Clawback params (#152) for one locked coin — wire-safe (decimal strings). `seconds` is an
 * ABSOLUTE unix timestamp, not a duration. */
export interface WireClawbackInfo {
  senderPuzzleHashHex: string;
  receiverPuzzleHashHex: string;
  seconds: string;
  amount: string;
}
/** One pending clawback (#152) — either an incoming coin this wallet can CLAIM, or an outgoing one
 * (from this wallet+index's own activity log) it can still CLAW BACK. */
export interface PendingClawback {
  direction: 'incoming' | 'outgoing';
  info: WireClawbackInfo;
  coinIdHex: string;
}
/** A prepared (unsigned) clawback claim/claw-back: the pending id + the amount actually delivered. */
export interface PreparedClawbackAction {
  pendingId: string;
  clawbackAmountOut: string;
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

/**
 * Shared `onQueryStarted` for every mutation that can change the ACTIVE wallet identity or its
 * active HD derivation index (create / import / switch / remove-re-homing a wallet; navigate the
 * index — #162, #165): once the SW CONFIRMS the change, wipe the WHOLE `api` cache
 * (`resetApiState`) so every wallet-scoped view (Balances/Activity/Collectibles/Identity/Coins/
 * Address/Wallets/LockState) drops the PREVIOUS identity's cached entry and re-renders its LOADING
 * state — never the old identity's data, never "unavailable" (#158).
 *
 * `invalidatesTags` alone is NOT enough here: RTK Query's tag invalidation only schedules a
 * background refetch — a subscribed query keeps serving its last-known (stale, wrong-identity)
 * `data` with `isLoading: false` for the whole refetch window (`isFetching` is the only signal that
 * changes), which is exactly the bug reported (the previous wallet's balances/activity linger on
 * screen after a switch). `resetApiState()` drops the cached data immediately AND causes every
 * still-subscribed hook to re-`initiate` from scratch (RTK Query's own subscription-recovery path),
 * landing back in the uninitialized/pending state instead.
 *
 * A FAILED mutation (e.g. `NEEDS_UNLOCK`, `LAST_WALLET`, `NO_WALLET`) leaves the active identity
 * unchanged, so `queryFulfilled` rejects and nothing is reset — the current wallet's data must stay
 * on screen untouched when a switch attempt merely prompts for a password.
 */
async function resetCacheOnIdentityChange(
  queryFulfilled: PromiseLike<unknown>,
  dispatch: ThunkDispatch<unknown, unknown, UnknownAction>,
): Promise<void> {
  try {
    await queryFulfilled;
    dispatch(api.util.resetApiState());
  } catch {
    // The mutation failed (NEEDS_UNLOCK / LAST_WALLET / NO_WALLET / wrong password, …) — the active
    // wallet/index never changed, so the existing cache is still correct. Nothing to reset.
  }
}

export const custodyApi = api.injectEndpoints({
  endpoints: (build) => ({
    getLockState: build.query<LockStateResult, void>({
      query: () => ({ action: ACTIONS.getLockState }),
      providesTags: ['LockState'],
    }),

    createWallet: build.mutation<CreateWalletResult, { password: string; label?: string; strong?: boolean }>({
      query: (arg) => ({ action: ACTIONS.createWallet, ...arg }),
      invalidatesTags: ACTIVE_WALLET_INVALIDATION,
      onQueryStarted: (_arg, { dispatch, queryFulfilled }) => resetCacheOnIdentityChange(queryFulfilled, dispatch),
    }),

    importWallet: build.mutation<
      UnlockResult,
      { mnemonic: string; password: string; label?: string; strong?: boolean }
    >({
      query: (arg) => ({ action: ACTIONS.importWallet, ...arg }),
      invalidatesTags: ACTIVE_WALLET_INVALIDATION,
      onQueryStarted: (_arg, { dispatch, queryFulfilled }) => resetCacheOnIdentityChange(queryFulfilled, dispatch),
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
      onQueryStarted: (_arg, { dispatch, queryFulfilled }) => resetCacheOnIdentityChange(queryFulfilled, dispatch),
    }),
    // Rename one wallet (metadata only — no key, no password). Only the registry list changes.
    renameWallet: build.mutation<WalletsMutationResult, { walletId: string; label: string }>({
      query: (arg) => ({ action: ACTIONS.renameWallet, ...arg }),
      invalidatesTags: ['Wallets'],
    }),
    // Remove one wallet (zeroizes its cached key); refuses the last (LAST_WALLET). Removing the active
    // one re-homes active, so invalidate the full wallet-derived set alongside the registry list, and
    // reset the whole cache (#162) since re-homing switches identity exactly like switchWallet does.
    removeWallet: build.mutation<WalletsMutationResult, { walletId: string }>({
      query: (arg) => ({ action: ACTIONS.removeWallet, ...arg }),
      invalidatesTags: ACTIVE_WALLET_INVALIDATION,
      onQueryStarted: (_arg, { dispatch, queryFulfilled }) => resetCacheOnIdentityChange(queryFulfilled, dispatch),
    }),

    // ── Single active derivation index (#165) ──
    // Navigate the active wallet's active HD derivation index (prev/next/jump — the caller computes
    // the absolute target index). Every index-scoped view re-reads for the newly-active index.
    setActiveIndex: build.mutation<{ activeIndex: number }, { index: number }>({
      query: (arg) => ({ action: ACTIONS.setActiveIndex, ...arg }),
      invalidatesTags: ACTIVE_INDEX_INVALIDATION,
      onQueryStarted: (_arg, { dispatch, queryFulfilled }) => resetCacheOnIdentityChange(queryFulfilled, dispatch),
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

    // ── Private-key reveal (#96) ──
    // A mutation (never a cached query) so the sensitive key is never retained in the query cache —
    // same discipline as revealPhrase. Re-auths with the full password; refused WATCH_ONLY for a
    // watch-only active wallet.
    exportPrivateKey: build.mutation<ExportPrivateKeyResult, { password: string }>({
      query: (arg) => ({ action: ACTIONS.exportPrivateKey, ...arg }),
    }),

    // ── Watch-only wallet (#96) ──
    // Add a spend-less wallet from a master/root public key only. Activates it (like create/import),
    // so wipe the whole cache (#162) exactly like the other identity-changing mutations.
    importWatchWallet: build.mutation<ImportWatchResult, { publicKeyHex: string; label?: string }>({
      query: (arg) => ({ action: ACTIONS.importWatchWallet, ...arg }),
      invalidatesTags: ACTIVE_WALLET_INVALIDATION,
      onQueryStarted: (_arg, { dispatch, queryFulfilled }) => resetCacheOnIdentityChange(queryFulfilled, dispatch),
    }),

    // ── Named accounts (#95) ──
    // Add/rename/remove a named account of the ACTIVE wallet. Only the registry list changes for
    // add/rename; removing the ACTIVE account re-homes the index server-side, so it invalidates the
    // index-scoped set too (Balances/Activity/Address/Collectibles/Coins) alongside Wallets.
    addAccount: build.mutation<AccountsResult, { label?: string }>({
      query: (arg) => ({ action: ACTIONS.addAccount, ...arg }),
      invalidatesTags: ['Wallets'],
    }),
    renameAccount: build.mutation<AccountsResult, { accountId: string; label: string }>({
      query: (arg) => ({ action: ACTIONS.renameAccount, ...arg }),
      invalidatesTags: ['Wallets'],
    }),
    removeAccount: build.mutation<AccountsResult, { accountId: string }>({
      query: (arg) => ({ action: ACTIONS.removeAccount, ...arg }),
      invalidatesTags: ['Wallets', ...ACTIVE_INDEX_INVALIDATION],
    }),

    // ── Encrypted keystore file backup/restore (#115) ──
    // Export a wallet's own encrypted record as a downloadable file — a mutation (never cached), no
    // cache impact (read-only over the registry).
    exportWalletBackup: build.mutation<ExportBackupResult, { walletId: string }>({
      query: (arg) => ({ action: ACTIONS.exportWalletBackup, ...arg }),
    }),
    // Restore a wallet from a backup file's JSON — adds it, active + LOCKED. Identity change → reset.
    importWalletBackup: build.mutation<{ activeWalletId: string; lockState: LockState }, { json: string; label?: string }>({
      query: (arg) => ({ action: ACTIONS.importWalletBackup, ...arg }),
      invalidatesTags: ACTIVE_WALLET_INVALIDATION,
      onQueryStarted: (_arg, { dispatch, queryFulfilled }) => resetCacheOnIdentityChange(queryFulfilled, dispatch),
    }),

    getReceiveAddress: build.query<{ address: string }, void>({
      query: () => ({ action: ACTIONS.getReceiveAddress }),
      providesTags: ['Address'],
    }),

    // Derived-address list (#106): a read-only page of the active wallet's addresses (BOTH HD
    // schemes, indexes 0..count-1) for viewing/copying — pure local derivation, independent of the
    // active index (#165's single-active-index model is unaffected; this never drives a balance
    // view). `count` omitted uses the vault's small default page.
    getDerivedAddresses: build.query<{ addresses: DerivedAddress[] }, { count?: number } | void>({
      query: (arg) => ({ action: ACTIONS.listDerivedAddresses, ...(arg?.count ? { count: arg.count } : {}) }),
      providesTags: ['Address'],
    }),

    getCustodyBalances: build.query<CustodyBalances, void>({
      query: () => ({ action: ACTIONS.getCustodyBalances }),
      providesTags: ['Balances'],
    }),

    // Build (not broadcast) a send → returns the decoded summary to approve. An optional `assetId`
    // routes a CAT send (#121); an optional `coinIds` hand-picks the funding coins (#91). An optional
    // `clawbackSeconds` (#152, XCH only) sends WITH a reclaimable timelock instead of a plain send.
    // An optional `memo` (#105) attaches a plain-text note to the recipient's CREATE_COIN — PUBLIC
    // on chain, and mutually exclusive with `clawbackSeconds` (the vault rejects combining them).
    prepareSend: build.mutation<PreparedSend, { recipient: string; amount: string; fee?: string; assetId?: string; coinIds?: string[]; clawbackSeconds?: string; memo?: string }>({
      query: (arg) => ({ action: ACTIONS.prepareSend, ...arg }),
    }),
    // Sign + BROADCAST a prepared send / split / combine (the approved step). Invalidates the caches.
    // 'Clawbacks' too (#152): a send-with-clawback creates a new pending OUTGOING entry.
    confirmSend: build.mutation<{ spentCoinId: string }, { pendingId: string }>({
      query: (arg) => ({ action: ACTIONS.confirmSend, ...arg }),
      invalidatesTags: ['Balances', 'Activity', 'Coins', 'Clawbacks'],
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

    // ── Clawback (#152) ──
    // The wallet's currently-pending clawbacks: INCOMING (discovered on chain by hint) + OUTGOING
    // (from this wallet+index's own activity log, checked against live chain state).
    getClawbacks: build.query<{ clawbacks: PendingClawback[] }, void>({
      query: () => ({ action: ACTIONS.listClawbacks }),
      providesTags: ['Clawbacks'],
    }),
    // Build (not broadcast) the CLAIM (receiver) / CLAW BACK (sender) spend → held under a pending
    // id + the amount actually delivered to approve. Broadcast via confirmClawbackAction.
    prepareClawbackAction: build.mutation<PreparedClawbackAction, { direction: 'claim' | 'reclaim'; clawbackInfo: WireClawbackInfo; fee?: string }>({
      query: (arg) => ({ action: ACTIONS.prepareClawbackAction, ...arg }),
    }),
    // Sign + BROADCAST a prepared clawback claim/claw-back (the approved step).
    confirmClawbackAction: build.mutation<{ spentCoinId: string }, { pendingId: string }>({
      query: (arg) => ({ action: ACTIONS.confirmClawbackAction, ...arg }),
      invalidatesTags: ['Balances', 'Activity', 'Clawbacks'],
    }),

    // The LOCAL activity log (#154) for the active wallet + index — an instant storage read, NOT an
    // on-chain scan (see src/background/index.ts's getActivity + src/lib/activity-log.ts).
    getCustodyActivity: build.query<{ events: LocalActivityEntry[] }, void>({
      query: () => ({ action: ACTIONS.getActivity }),
      providesTags: ['Activity'],
    }),

    // ── Trade offers (#56, multi-asset #100, saved/active management #101) ──
    // Build (not broadcast) a shareable offer → the `offer1…` string + two-sided summary. `offered`/
    // `requested` are ARRAYS (#100) — 1 or more legs per side; a single-asset offer is a 1-element
    // array. The SW persists an #101 offer-log entry as a side effect, so this also invalidates 'Offers'.
    makeCustodyOffer: build.mutation<{ offer: string; offerSummary: WireOfferSummary; offerCoinIds?: string[] }, { offered: WireOfferLeg[]; requested: WireOfferLeg[]; fee?: string }>({
      query: (arg) => ({ action: ACTIONS.makeOffer, ...arg }),
      invalidatesTags: ['Offers'],
    }),
    // Decode an offer string → its two-sided summary (read-only review).
    inspectCustodyOffer: build.mutation<{ offerSummary: WireOfferSummary }, { offerStr: string }>({
      query: (arg) => ({ action: ACTIONS.inspectOffer, ...arg }),
    }),
    // Build + sign (not broadcast) a take/cancel → held under a pending id + summary to approve.
    prepareTrade: build.mutation<{ pendingId: string; offerSummary: WireOfferSummary }, { offerStr: string; tradeKind: 'take' | 'cancel'; fee?: string }>({
      query: (arg) => ({ action: ACTIONS.prepareTrade, ...arg }),
    }),
    // BROADCAST a prepared trade (the approved step). Invalidates balances/activity, plus 'Offers'
    // (#101) since a CANCEL of a made offer flips its log entry's status.
    confirmTrade: build.mutation<{ spentCoinId: string }, { pendingId: string }>({
      query: (arg) => ({ action: ACTIONS.confirmTrade, ...arg }),
      invalidatesTags: ['Balances', 'Activity', 'Offers'],
    }),

    // ── Saved/active offer management (#101) ──
    // The LOCAL "your offers" log for the active wallet + index: every offer this wallet has MADE,
    // with derived status (open/taken/cancelled) — an instant storage read reconciled against the
    // chain for open entries, NOT a marketplace scan. See src/lib/offer-log.ts.
    getCustodyOffers: build.query<{ offers: OfferLogEntry[] }, void>({
      query: () => ({ action: ACTIONS.getOffers }),
      providesTags: ['Offers'],
    }),

    // ── CAT issuance (#97) — mint a brand-new CAT; fullscreen-only advanced op ──
    // Build (not broadcast) an issuance → held under a pending id + the new asset id + summary to
    // approve. Broadcast via confirmCatIssuance.
    prepareCatIssuance: build.mutation<{ pendingId: string; assetId: string; catIssuanceSummary: CatIssuanceSummary }, { catIssuance: WireCatIssuanceParams }>({
      query: (arg) => ({ action: ACTIONS.prepareCatIssuance, ...arg }),
    }),
    // Sign + BROADCAST a prepared CAT issuance (the approved step). Invalidates balances/activity.
    confirmCatIssuance: build.mutation<{ spentCoinId: string }, { pendingId: string }>({
      query: (arg) => ({ action: ACTIONS.confirmCatIssuance, ...arg }),
      invalidatesTags: ['Balances', 'Activity', 'Coins'],
    }),

    // ── Option contracts (#104) — mint a new XCH-denominated option; exercise one held; fullscreen-only ──
    // Build (not broadcast) a mint → held under a pending id + the FULL optionRecord + summary to
    // approve. Broadcast via confirmOptionMint (the SW records it into the local registry then).
    prepareOptionMint: build.mutation<{ pendingId: string; optionMintSummary: OptionMintSummary; optionRecord: OptionRecord }, { optionMint: WireOptionMintParams }>({
      query: (arg) => ({ action: ACTIONS.prepareOptionMint, ...arg }),
    }),
    // Sign + BROADCAST a prepared option mint (the approved step). `optionRecord` (echoed back from
    // prepareOptionMint) is REQUIRED so the SW can record the full terms locally.
    confirmOptionMint: build.mutation<{ spentCoinId: string }, { pendingId: string; optionRecord: OptionRecord }>({
      query: (arg) => ({ action: ACTIONS.confirmOptionMint, ...arg }),
      invalidatesTags: ['Balances', 'Activity', 'Options'],
    }),
    // Build (not broadcast) an exercise of an option this wallet holds → held under a pending id +
    // summary to approve. Broadcast via confirmOptionExercise.
    prepareOptionExercise: build.mutation<{ pendingId: string; optionExerciseSummary: OptionExerciseSummary }, { optionRecord: OptionRecord; fee?: string }>({
      query: (arg) => ({ action: ACTIONS.prepareOptionExercise, ...arg }),
    }),
    // Sign + BROADCAST a prepared option exercise (the approved step). Invalidates balances/activity/Options.
    confirmOptionExercise: build.mutation<{ spentCoinId: string }, { pendingId: string }>({
      query: (arg) => ({ action: ACTIONS.confirmOptionExercise, ...arg }),
      invalidatesTags: ['Balances', 'Activity', 'Options'],
    }),
    // The LOCAL option registry for the active wallet + index — every option this wallet has
    // minted, reconciled against the chain (open → exercised once the coin is spent).
    getOptions: build.query<{ options: OptionLogEntry[] }, void>({
      query: () => ({ action: ACTIONS.getOptions }),
      providesTags: ['Options'],
    }),

    // ── dexie marketplace integration (#102) — NOT custody actions (no wallet key involved) ──
    // POST an already-built offer to dexie so other wallets can discover it.
    postOfferToDexie: build.mutation<{ dexieId: string; known: boolean }, { offer: string }>({
      query: (arg) => ({ action: ACTIONS.dexiePost, ...arg }),
    }),
    // Browse currently-open dexie offers, optionally filtered by offered/requested asset.
    browseDexieOffers: build.query<{ offers: DexieOfferSummary[] }, { offered?: string; requested?: string } | void>({
      query: (arg) => ({ action: ACTIONS.dexieBrowse, ...(arg ?? {}) }),
    }),
    // Resolve a pasted dexie link/id to its offer1… bytes (Take then inspects it like a pasted offer).
    resolveDexieOffer: build.mutation<{ offer: DexieOfferSummary | null }, { idOrUrl: string }>({
      query: (arg) => ({ action: ACTIONS.dexieResolve, ...arg }),
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
  useExportPrivateKeyMutation,
  useImportWatchWalletMutation,
  useAddAccountMutation,
  useRenameAccountMutation,
  useRemoveAccountMutation,
  useExportWalletBackupMutation,
  useImportWalletBackupMutation,
  useGetReceiveAddressQuery,
  useGetDerivedAddressesQuery,
  useGetCustodyBalancesQuery,
  usePrepareSendMutation,
  useConfirmSendMutation,
  useLazySendStatusQuery,
  useGetCoinsQuery,
  usePrepareSplitMutation,
  usePrepareCombineMutation,
  useGetClawbacksQuery,
  usePrepareClawbackActionMutation,
  useConfirmClawbackActionMutation,
  useGetCustodyActivityQuery,
  useMakeCustodyOfferMutation,
  useInspectCustodyOfferMutation,
  usePrepareTradeMutation,
  useConfirmTradeMutation,
  useGetCustodyOffersQuery,
  usePostOfferToDexieMutation,
  useBrowseDexieOffersQuery,
  useResolveDexieOfferMutation,
  usePrepareCatIssuanceMutation,
  useConfirmCatIssuanceMutation,
  usePrepareOptionMintMutation,
  useConfirmOptionMintMutation,
  usePrepareOptionExerciseMutation,
  useConfirmOptionExerciseMutation,
  useGetOptionsQuery,
} = custodyApi;
