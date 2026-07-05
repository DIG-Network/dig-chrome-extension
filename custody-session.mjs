/**
 * Self-custody session logic for the service worker (#56) — the PURE decision layer the SW glue in
 * background.js calls, kept chrome.*-free so it is fully node-testable. It owns:
 *   - which actions route to the offscreen keystore vault,
 *   - the unlock-TTL math (a non-secret expiry timestamp kept in `storage.session`), and
 *   - the tri-state lock-state derivation from (keystore-present, key-in-vault, expiry, now).
 *
 * The decrypted key NEVER lives here or in the SW — it lives only in the offscreen document. This
 * module reasons about lifecycle facts (does a keystore blob exist? is the vault holding a key? has
 * the TTL lapsed?) and never touches key material.
 *
 * Plain ES module so background.js (SW), the offscreen doc, and `node --test` can all import it.
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
/** HD scan gap limit per scheme for balance scans. */
export const SCAN_GAP_LIMIT = 20;

/** Resolve the chain RPC URL: an explicit `settings.chainRpcUrl` override wins, else coinset.org. */
export function resolveCoinsetUrl(settings) {
  const url = settings && typeof settings.chainRpcUrl === 'string' ? settings.chainRpcUrl.trim() : '';
  return url || DEFAULT_COINSET_URL;
}

/** Default auto-lock TTL: 10 minutes (§5.5), user-configurable via `settings.unlockTtlMinutes`. */
export const DEFAULT_UNLOCK_TTL_MINUTES = 10;
/** Bounds so a bad/hostile settings value can't disable auto-lock or thrash it. */
export const MIN_UNLOCK_TTL_MINUTES = 1;
export const MAX_UNLOCK_TTL_MINUTES = 60;

/** Tri-state lock state surfaced to the UI. */
export const LOCK_STATE = Object.freeze({ NONE: 'none', LOCKED: 'locked', UNLOCKED: 'unlocked' });

/**
 * The actions the SW forwards to the offscreen vault (as opposed to handling itself). `getLockState`
 * is included because computing it needs the vault's in-memory "do I hold a key?" fact.
 * @readonly
 */
export const CUSTODY_ACTIONS = Object.freeze([
  'createWallet',
  'importWallet',
  'unlockWallet',
  'lockWallet',
  'revealPhrase',
  'getLockState',
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
]);

/** True if `action` is a custody action the SW routes to the offscreen vault. */
export function isCustodyAction(action) {
  return typeof action === 'string' && CUSTODY_ACTIONS.includes(action);
}

/** Clamp a settings TTL (minutes) into the allowed range, falling back to the default. */
export function resolveTtlMinutes(settings) {
  const raw = settings && typeof settings.unlockTtlMinutes === 'number' ? settings.unlockTtlMinutes : NaN;
  if (!Number.isFinite(raw)) return DEFAULT_UNLOCK_TTL_MINUTES;
  return Math.min(MAX_UNLOCK_TTL_MINUTES, Math.max(MIN_UNLOCK_TTL_MINUTES, Math.floor(raw)));
}

/** Compute the absolute unlock-expiry timestamp (ms) from `now` and a TTL in minutes. */
export function computeUnlockExpiry(now, ttlMinutes = DEFAULT_UNLOCK_TTL_MINUTES) {
  return now + ttlMinutes * 60_000;
}

/** True if the unlock window has lapsed (missing/zero/NaN expiry counts as expired). */
export function isUnlockExpired(unlockExpiry, now) {
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
export function deriveLockState({ hasKeystore, hasKeyInVault, unlockExpiry, now }) {
  if (!hasKeystore) return LOCK_STATE.NONE;
  if (!hasKeyInVault) return LOCK_STATE.LOCKED;
  return isUnlockExpired(unlockExpiry, now) ? LOCK_STATE.LOCKED : LOCK_STATE.UNLOCKED;
}
