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

/** `chrome.storage.local` key holding the encrypted DIGWX1 keystore blob (the only at-rest secret). */
export const KEYSTORE_KEY = 'wallet.keystore';
/** `chrome.storage.local` key: the durable settings blob (unlock TTL, fee default, overrides…). */
export const SETTINGS_KEY = 'wallet.settings';
/** `chrome.storage.local` key: the active wallet id (multi-wallet switcher, #56). */
export const ACTIVE_WALLET_KEY = 'wallet.activeId';
/** `chrome.storage.session` key: the NON-SECRET unlock-expiry timestamp (ms). Never key material. */
export const UNLOCK_EXPIRY_KEY = 'wallet.unlockExpiry';
/** `chrome.storage.local` key: cached last balance scan (non-secret) for cached-first paint. */
export const BALANCES_CACHE_KEY = 'walletCache.balances';
/** `chrome.storage.local` key: cached activity ledger + height cursor (non-secret). */
export const ACTIVITY_CACHE_KEY = 'walletCache.activity';

/** The default public coinset chain source (extensions bypass its CORS). */
export const DEFAULT_COINSET_URL = 'https://api.coinset.org';

/** The persisted self-custody settings blob (all fields optional / user-configurable). */
export interface CustodySettings {
  chainRpcUrl?: string;
  unlockTtlMinutes?: number;
  [key: string]: unknown;
}

/** Resolve the chain RPC URL: an explicit `settings.chainRpcUrl` override wins, else coinset.org. */
export function resolveCoinsetUrl(settings?: CustodySettings | null): string {
  const url = settings && typeof settings.chainRpcUrl === 'string' ? settings.chainRpcUrl.trim() : '';
  return url || DEFAULT_COINSET_URL;
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
  'getCustodyBalances',
  'prepareSend',
  'confirmSend',
  'sendStatus',
  'getActivity',
  'makeOffer',
  'inspectOffer',
  'prepareTrade',
  'confirmTrade',
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
  'listCoins',
  'prepareSplit',
  'prepareCombine',
] as const);

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
}

/** The `prepareSend` request the SW forwards to the offscreen vault. */
export interface PrepareSendVaultRequest {
  op: 'prepareSend';
  recipient?: string;
  amount?: string;
  fee?: string;
  assetId?: string;
  coinIds?: string[];
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
  now,
}: {
  hasKeystore: boolean;
  activeWalletId?: string | null;
  unlockExpiry?: number | null;
  activeIndex?: number;
  now: number;
}): LockSnapshot {
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
