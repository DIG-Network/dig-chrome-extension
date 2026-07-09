/**
 * Self-custody session logic for the service worker (#56) — the PURE decision layer the SW glue in
 * src/background/index.ts calls, kept chrome.*-free so it is fully unit-testable. It owns:
 *   - which actions route to the offscreen keystore vault,
 *   - the unlock-TTL math (a non-secret expiry timestamp kept in `storage.session`), and
 *   - the tri-state lock-state derivation from (keystore-present, key-in-vault, expiry, now).
 *
 * The decrypted key NEVER lives here or in the SW — it lives only in the offscreen document. This
 * module reasons about lifecycle facts (does a keystore blob exist? is the vault holding a key? has
 * the TTL lapsed?) and never touches key material.
 */

import { resolveNetwork } from '@/lib/network';

/** `chrome.storage.local` key holding the encrypted DIGWX1 keystore blob (the only at-rest secret). */
export const KEYSTORE_KEY = 'wallet.keystore';
/** `chrome.storage.local` key: the durable settings blob (unlock TTL, fee default, overrides…). */
export const SETTINGS_KEY = 'wallet.settings';
/** `chrome.storage.local` key: the active wallet id (multi-wallet switcher, #56). */
export const ACTIVE_WALLET_KEY = 'wallet.activeId';
/** `chrome.storage.session` key: the NON-SECRET unlock-expiry timestamp (ms). Never key material. */
export const UNLOCK_EXPIRY_KEY = 'wallet.unlockExpiry';
/** `chrome.storage.local` key: cached last balance scan (non-secret) for cached-first paint. ALSO
 * the receive-delta baseline (#154): a fresh `getCustodyBalances` scan diffs against this snapshot
 * to detect an incoming coin, so it is intentionally dropped on wallet/index switch
 * (`clearActiveWalletCaches`) — the first scan after a switch has no baseline and skips detection,
 * which is exactly what prevents a wallet's pre-existing balance misreporting as a fresh "receive". */
export const BALANCES_CACHE_KEY = 'walletCache.balances';
/** `chrome.storage.local` key: the LOCAL activity log (#154) — see `src/lib/activity-log.ts`. A flat
 * map keyed by wallet+active-index (`logKey`), holding each scope's own ring-buffered entries. This
 * is DURABLE history, not a re-fetchable cache — UNLIKE {@link BALANCES_CACHE_KEY} it is NEVER
 * cleared on wallet switch or index navigation; per-wallet/index isolation comes from the composite
 * key alone. Supersedes the old `walletCache.activity` (a cache of an on-chain scan's result, retired
 * with the heavy `includeSpent: true` coinset reconstruction it cached). */
export const ACTIVITY_LOG_KEY = 'wallet.activityLog';
/** `chrome.storage.local` key: the LOCAL offer log (#101) — offers this wallet has MADE, with
 * derived status (open/taken/cancelled). See `src/lib/offer-log.ts`. Same durable-history semantics
 * as {@link ACTIVITY_LOG_KEY} (never cleared on wallet switch or index navigation). */
export const OFFER_LOG_KEY = 'wallet.offerLog';
/** `chrome.storage.local` key: the LOCAL option-contract registry (#104) — options this wallet has
 * MINTED, with derived status (open/exercised). See `src/lib/optionContractLog.ts`. Same durable-
 * history semantics as {@link ACTIVITY_LOG_KEY} (never cleared on wallet switch or index navigation). */
export const OPTION_LOG_KEY = 'wallet.optionLog';

/** The default public coinset chain source (extensions bypass its CORS). Mainnet — see `resolveNetwork`. */
export const DEFAULT_COINSET_URL = 'https://api.coinset.org';

/** The persisted self-custody settings blob (all fields optional / user-configurable). */
export interface CustodySettings {
  chainRpcUrl?: string;
  unlockTtlMinutes?: number;
  /** Active chain network (#108): 'mainnet' | 'testnet'. Missing/unrecognized → mainnet. */
  network?: string;
  [key: string]: unknown;
}

/**
 * Resolve the chain RPC URL: an explicit `settings.chainRpcUrl` override ALWAYS wins (§5.3 — a
 * user's own node); absent that, the selected network's default coinset endpoint applies (#108) —
 * `DEFAULT_COINSET_URL` (mainnet) when `network` is missing/unrecognized, so this is unchanged
 * back-compat behavior for every caller that predates the network switcher.
 */
export function resolveCoinsetUrl(settings?: CustodySettings | null): string {
  const url = settings && typeof settings.chainRpcUrl === 'string' ? settings.chainRpcUrl.trim() : '';
  if (url) return url;
  return resolveNetwork(settings?.network).coinsetUrl;
}

/**
 * Default auto-lock TTL: 15 minutes — a MetaMask-style idle window (#155), user-configurable via
 * `settings.unlockTtlMinutes` (Settings → Auto-lock). Paired with {@link isSessionRenewingAction}:
 * the window slides forward on real wallet activity, so an actively-used wallet never re-prompts
 * mid-session — only genuine inactivity (or an explicit Lock) ends it.
 */
export const DEFAULT_UNLOCK_TTL_MINUTES = 15;
/** Bounds so a bad/hostile settings value can't disable auto-lock or thrash it. */
export const MIN_UNLOCK_TTL_MINUTES = 1;
export const MAX_UNLOCK_TTL_MINUTES = 60;

/** Tri-state lock state surfaced to the UI. */
export const LOCK_STATE = Object.freeze({ NONE: 'none', LOCKED: 'locked', UNLOCKED: 'unlocked' } as const);

/** One of the tri-state lock-state string values. */
export type LockStateValue = (typeof LOCK_STATE)[keyof typeof LOCK_STATE];

/**
 * The self-custody actions `handleCustodyAction` owns (routed there by {@link isCustodyAction}). Most
 * forward to the offscreen vault; a few are pure SW registry ops (#90 multi-wallet: `listWallets` /
 * `renameWallet` read+write the registry metadata, while `switchWallet` / `removeWallet` also touch
 * the vault to (de)activate cached keys). `getLockState` is included because it is answered here.
 */
export const CUSTODY_ACTIONS = Object.freeze([
  'createWallet',
  'importWallet',
  'unlockWallet',
  'lockWallet',
  'revealPhrase',
  'getLockState',
  // Multi-wallet switcher (#90): the registry list + switch/rename/remove.
  'listWallets',
  'switchWallet',
  'renameWallet',
  'removeWallet',
  // Single active derivation index (#165): prev/next/jump changes which index every wallet view
  // reflects. A pure SW registry op (like renameWallet) — no vault round-trip, no key involved.
  'setActiveIndex',
  'getReceiveAddress',
  // Derived-address list (#106): a read-only page of both-scheme addresses for viewing/copying.
  'listDerivedAddresses',
  'getCustodyBalances',
  'prepareSend',
  'confirmSend',
  'sendStatus',
  'getActivity',
  'makeOffer',
  'inspectOffer',
  'prepareTrade',
  'confirmTrade',
  // Saved/active offer management (#101): the local "your offers" log for the active wallet+index.
  'getOffers',
  'listNfts',
  'prepareNftTransfer',
  'confirmNftTransfer',
  // NFT minting (#92): build + broadcast a new NFT.
  'prepareNftMint',
  'confirmNftMint',
  // DID management (#93): create/list/transfer/profile-update a self-custody identity, and assign a
  // wallet-owned DID as an owned NFT's owner.
  'listDids',
  'prepareDidCreate',
  'confirmDidCreate',
  'prepareDidTransfer',
  'confirmDidTransfer',
  'prepareDidProfileUpdate',
  'confirmDidProfileUpdate',
  'prepareNftDidAssign',
  'confirmNftDidAssign',
  'prepareNftBulkDidAssign',
  'confirmNftBulkDidAssign',
  'listCoins',
  'prepareSplit',
  'prepareCombine',
  // Clawback (#152): list pending incoming/outgoing + claim (receiver) / claw back (sender).
  'listClawbacks',
  'prepareClawbackAction',
  'confirmClawbackAction',
  // Private-key export (#96): the raw account secret key at the active index, both schemes.
  'exportPrivateKey',
  // Watch-only wallets (#96): add a spend-less wallet from a public key only.
  'importWatchWallet',
  // Named accounts (#95): distinct derivation indices under one wallet's seed/key.
  'addAccount',
  'renameAccount',
  'removeAccount',
  // Encrypted keystore file backup/restore (#115): move a wallet's own DIGWX1 record as a file.
  'exportWalletBackup',
  'importWalletBackup',
] as const);

/**
 * Actions that require the ACTIVE wallet's own signing key — refused with `WATCH_ONLY` (§96) before
 * ever reaching the vault when the active wallet is a spend-less watch-only entry (no secret at
 * all). Read-only actions (balances/addresses/lists) are deliberately NOT here — they route to the
 * public-key derivation path instead (`getReceiveAddress`/`scanBalances`/`listDerivedAddresses`
 * accept `watchPublicKeyHex`); only an action that would need to SIGN or reveal a secret belongs in
 * this set.
 */
export const SIGNING_REQUIRED_ACTIONS = Object.freeze([
  'revealPhrase',
  'exportPrivateKey',
  'prepareSend',
  'prepareSplit',
  'prepareCombine',
  'makeOffer',
  'prepareTrade',
  'prepareNftTransfer',
  'prepareNftBulkTransfer',
  'prepareNftBulkBurn',
  'prepareNftMint',
  'prepareDidCreate',
  'prepareDidTransfer',
  'prepareDidProfileUpdate',
  'prepareNftDidAssign',
  'prepareNftBulkDidAssign',
  'prepareClawbackAction',
] as const);

/** True if `action` requires the active wallet's own secret key (refused `WATCH_ONLY` for a
 * watch-only active wallet, #96). */
export function requiresSigningKey(action: unknown): boolean {
  return typeof action === 'string' && (SIGNING_REQUIRED_ACTIONS as readonly string[]).includes(action);
}

/** True if `action` is a custody action the SW routes to the offscreen vault. */
export function isCustodyAction(action: unknown): boolean {
  return typeof action === 'string' && (CUSTODY_ACTIONS as readonly string[]).includes(action);
}

/**
 * True if `action` represents real wallet activity that should slide the idle auto-lock window
 * forward (#155 — a MetaMask-style renewing idle timer: "keep unlocked for the session" means
 * unlocked for as long as the wallet is actively used, not merely for a fixed span from the
 * original unlock). The SW calls `startUnlockWindow()` again whenever this is true AND the wallet
 * was already unlocked, so a session in active use never lapses mid-task.
 *
 * Excludes two actions on purpose:
 *  - `getLockState`  — a passive status read. If merely checking status renewed the window, a
 *    background poll could keep a session "unlocked" forever without any real use.
 *  - `lockWallet`    — the opposite of activity. It must end the session, never resurrect one.
 *
 * Every other custody action (including `unlockWallet`/`createWallet`/`importWallet`/
 * `switchWallet`, which also start their own window on a locked→unlocked transition) counts as
 * activity; renewing on top of their own `startUnlockWindow()` call is a harmless no-op.
 */
export function isSessionRenewingAction(action: unknown): boolean {
  return isCustodyAction(action) && action !== 'getLockState' && action !== 'lockWallet';
}

/**
 * Compare-and-renew guard (#155): decide whether a just-completed renewing action is allowed to
 * re-arm the unlock window, given the unlock-expiry observed when the action STARTED
 * (`expiryAtActionStart`) and whatever is CURRENTLY in `chrome.storage.session`
 * (`currentExpiry`) once it finishes. Renewal is applied ONLY when nothing else changed the expiry
 * in between — closes a real race: a long-running activity call (e.g. a balance scan) that began
 * while the wallet was unlocked must NOT resurrect the session if an explicit `lockWallet` (or the
 * TTL sweep) completed while it was still in flight. `null`/`undefined` on either side means "no
 * fresh unlock to renew from" (never happened, or already cleared) — renewal is skipped.
 */
export function shouldApplyRenewal(
  expiryAtActionStart: number | null | undefined,
  currentExpiry: number | null | undefined,
): boolean {
  return expiryAtActionStart != null && currentExpiry === expiryAtActionStart;
}

/** A `prepareSend` custody message from the popup (the fields the SW forwards to the vault). */
export interface PrepareSendMessage {
  recipient?: string;
  amount?: string;
  fee?: string;
  /**
   * The CAT asset id (TAIL hex) for a token send; omitted / `'xch'` for a native XCH send. This is
   * the field #121 regressed on: the SW handler dropped it, so a selected CAT was silently built as
   * native XCH (the vault decides `isCat` purely from `assetId`).
   */
  assetId?: string;
  /** Coin control (#91): hand-picked coin ids (hex) to fund the send, overriding auto-selection. */
  coinIds?: string[];
  /** Send WITH a clawback window (#152, XCH only) — an absolute unix timestamp (decimal string)
   * after which the receiver may claim; strictly before it, only the sender may claw back. */
  clawbackSeconds?: string;
  /** An optional plain-text memo/note attached to the recipient's CREATE_COIN (#105) — PUBLIC on
   * chain. Mutually exclusive with `clawbackSeconds` (the vault rejects combining them). */
  memo?: string;
}

/** The `prepareSend` request the SW forwards to the offscreen vault. */
export interface PrepareSendVaultRequest {
  op: 'prepareSend';
  recipient?: string;
  amount?: string;
  fee?: string;
  assetId?: string;
  coinIds?: string[];
  clawbackSeconds?: string;
  memo?: string;
  coinsetUrl: string;
}

/**
 * Build the offscreen-vault request for a `prepareSend` custody action. It MUST forward `assetId`:
 * the vault routes native-XCH vs CAT purely on this field, so dropping it (the #121 bug) silently
 * turns a token send into a native-XCH send. Pure so the forwarding is unit-tested (the inline SW
 * mapping was untestable, which is why the drop shipped).
 */
export function prepareSendVaultRequest(
  message: PrepareSendMessage,
  coinsetUrl: string,
): PrepareSendVaultRequest {
  return {
    op: 'prepareSend',
    recipient: message.recipient,
    amount: message.amount,
    fee: message.fee,
    assetId: message.assetId,
    ...(message.coinIds && message.coinIds.length ? { coinIds: message.coinIds } : {}),
    ...(message.clawbackSeconds ? { clawbackSeconds: message.clawbackSeconds } : {}),
    ...(message.memo ? { memo: message.memo } : {}),
    coinsetUrl,
  };
}

/** Clamp a settings TTL (minutes) into the allowed range, falling back to the default. */
export function resolveTtlMinutes(settings?: CustodySettings | null): number {
  const raw = settings && typeof settings.unlockTtlMinutes === 'number' ? settings.unlockTtlMinutes : NaN;
  if (!Number.isFinite(raw)) return DEFAULT_UNLOCK_TTL_MINUTES;
  return Math.min(MAX_UNLOCK_TTL_MINUTES, Math.max(MIN_UNLOCK_TTL_MINUTES, Math.floor(raw)));
}

/** Compute the absolute unlock-expiry timestamp (ms) from `now` and a TTL in minutes. */
export function computeUnlockExpiry(now: number, ttlMinutes: number = DEFAULT_UNLOCK_TTL_MINUTES): number {
  return now + ttlMinutes * 60_000;
}

/** True if the unlock window has lapsed (missing/zero/NaN expiry counts as expired). */
export function isUnlockExpired(unlockExpiry: number | null | undefined, now: number): boolean {
  if (typeof unlockExpiry !== 'number' || !Number.isFinite(unlockExpiry) || unlockExpiry <= 0) return true;
  return now >= unlockExpiry;
}

/**
 * Minutes remaining until the auto-lock TTL lapses, rounded UP so `1` always means "under a minute
 * left" (never `0` while genuinely still unlocked) — drives the visible session countdown the
 * Settings surface renders alongside {@link AutoLockSetting} (#76 P1-4). `null` when there is no
 * live unlock window to count down (missing/invalid/already-lapsed expiry), so the caller can fall
 * back to an honest "unknown" label instead of showing a stale or negative number.
 */
export function minutesUntilLock(unlockExpiry: number | null | undefined, now: number): number | null {
  if (typeof unlockExpiry !== 'number' || !Number.isFinite(unlockExpiry) || unlockExpiry <= 0) return null;
  const remainingMs = unlockExpiry - now;
  if (remainingMs <= 0) return null;
  return Math.ceil(remainingMs / 60_000);
}

/**
 * Derive the lock state from lifecycle facts:
 *  - no keystore blob            → `none`   (no wallet yet — show onboarding)
 *  - blob, but no key in vault   → `locked`
 *  - blob + key in vault, expired→ `locked` (TTL lapsed; caller should also clear the vault)
 *  - blob + key in vault, fresh  → `unlocked`
 */
export function deriveLockState({
  hasKeystore,
  hasKeyInVault,
  unlockExpiry,
  now,
}: {
  hasKeystore: boolean;
  hasKeyInVault: boolean;
  unlockExpiry: number | null | undefined;
  now: number;
}): LockStateValue {
  if (!hasKeystore) return LOCK_STATE.NONE;
  if (!hasKeyInVault) return LOCK_STATE.LOCKED;
  return isUnlockExpired(unlockExpiry, now) ? LOCK_STATE.LOCKED : LOCK_STATE.UNLOCKED;
}

/** The storage-only lock snapshot the SW returns for getLockState. */
export interface LockSnapshot {
  lockState: LockStateValue;
  activeWalletId: string | null;
  unlockExpiry: number | null;
  /**
   * The active wallet's active HD derivation index (#165 — single active index model). `0` when
   * there is no keystore (nothing to derive from) or the active wallet has never set one.
   */
  activeIndex: number;
}

/**
 * Compute the full lock-state snapshot the UI's CustodyGate reads, PURELY from persisted facts:
 * whether the encrypted keystore blob exists in `chrome.storage.local` and the non-secret
 * unlock-expiry kept in `chrome.storage.session`. It NEVER consults the offscreen vault, so it
 * ALWAYS resolves immediately — a no-wallet user (who has no offscreen document at all) can never
 * leave `getLockState` pending, which is what stranded CustodyGate on "Loading wallet" (#68). The
 * SW spawns the offscreen document only when it actually unlocks / uses the key, not to read state.
 *
 * A fresh, unexpired unlock-expiry is the faithful proxy for "the wallet is unlocked": it is set
 * together with the decrypted key on create/import/unlock (`startUnlockWindow`) and cleared together
 * on lock / idle / TTL lapse (`lockVaultNow`, the auto-lock alarm). The auto-lock alarm independently
 * zeroizes the vault when the window lapses, so the two never stay desynced for long.
 *
 *   - no keystore blob          → `none`     (→ onboarding)
 *   - blob, expired/absent TTL  → `locked`   (→ unlock screen)
 *   - blob, fresh TTL           → `unlocked` (→ the wallet)
 *
 * `activeIndex` (#165) is likewise a persisted fact, not a vault read — the SW passes in the active
 * wallet's stored index (from the registry) so the whole navigator UI hydrates from one poll.
 */
export function computeLockSnapshot({
  hasKeystore,
  activeWalletId = null,
  unlockExpiry = null,
  activeIndex = 0,
  isWatchActive = false,
  now,
}: {
  hasKeystore: boolean;
  activeWalletId?: string | null;
  unlockExpiry?: number | null;
  activeIndex?: number;
  /**
   * #96 — true when the ACTIVE wallet is a watch-only entry (imported from a public key only). A
   * watch-only wallet holds no encrypted keystore at all and is never "locked" (there is nothing to
   * decrypt), so it reports UNCONDITIONALLY `unlocked` regardless of `hasKeystore`/`unlockExpiry`
   * (which reflect the SEPARATE `wallet.keystore` mirror, empty while a watch wallet is active).
   */
  isWatchActive?: boolean;
  now: number;
}): LockSnapshot {
  if (isWatchActive) {
    return {
      lockState: LOCK_STATE.UNLOCKED,
      activeWalletId: activeWalletId || null,
      unlockExpiry: null,
      activeIndex: activeIndex || 0,
    };
  }
  const lockState: LockStateValue = !hasKeystore
    ? LOCK_STATE.NONE
    : isUnlockExpired(unlockExpiry, now)
      ? LOCK_STATE.LOCKED
      : LOCK_STATE.UNLOCKED;
  return {
    lockState,
    activeWalletId: hasKeystore ? activeWalletId || null : null,
    unlockExpiry: hasKeystore ? unlockExpiry || null : null,
    activeIndex: hasKeystore ? activeIndex || 0 : 0,
  };
}
