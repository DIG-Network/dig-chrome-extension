/**
 * The multi-wallet REGISTRY (#90) — the pure decision layer over the DIGWX1 keystore that lets the
 * extension hold SEVERAL self-custody wallets and switch the active one. It is the storage MODEL +
 * the add / rename / remove / active-selection transforms; the service worker owns the
 * `chrome.storage.*` I/O around these helpers, and the offscreen vault owns every decrypted key.
 *
 * Storage shape (all under `chrome.storage.local`, §5):
 *   - `wallet.registry`  — the array of {@link WalletEntry} (each wallet's id, label, createdAt, and
 *                          its OWN encrypted DIGWX1 record — the same at-rest format as a single
 *                          wallet, one per wallet, so no new crypto is introduced).
 *   - `wallet.activeId`  — the id of the active wallet (drives balances / receive / send / activity).
 *   - `wallet.keystore`  — a MIRROR of the active wallet's record, so every pre-#90 single-wallet
 *                          read path (unlock / reveal) keeps working unchanged.
 *
 * This module is PURE (no chrome.* / DOM / crypto) so it is fully unit-tested and can be inlined into
 * the bundled service worker. It NEVER decrypts, and the metadata it exposes to the UI ({@link
 * WalletMeta}) is record-FREE — the encrypted records never leave the SW.
 */

import type { Digwx1Record } from '@/lib/keystore/digwx1';

/** `chrome.storage.local` key holding the wallet registry array (every wallet's record + metadata). */
export const WALLETS_KEY = 'wallet.registry';

/** Maximum label length (a friendly cap for a display name; longer is silently clamped). */
export const MAX_LABEL_LEN = 40;

/** Maximum account label length (#95 — same friendly cap as a wallet label). */
export const MAX_ACCOUNT_LABEL_LEN = 40;

/**
 * Upper bound on a persisted active derivation index (#165) — a sanity clamp, not a scan gap limit
 * (the single-active-index model derives exactly ONE index at a time, never a range). Generous
 * enough for any realistic HD usage while rejecting nonsense input (e.g. `Number.MAX_SAFE_INTEGER`).
 */
export const MAX_DERIVATION_INDEX = 1_000_000;

/**
 * One named sub-account (#95) — a user-friendly label BOOKMARKING a single HD derivation index
 * within one wallet's seed/key. Accounts do NOT introduce a second derivation dimension or a
 * multi-index scan (#165 stays the single-active-index model intact): switching to an account is
 * just `setWalletActiveIndex(wallet, account.index)` under a friendly name. Purely local metadata —
 * never persisted or read by the vault, never touches key material.
 */
export interface AccountEntry {
  /** Stable opaque id (a uuid) — the rename/remove key. */
  id: string;
  /** User-facing display name (e.g. "Savings"). */
  label: string;
  /** The HD derivation index (§165 semantics — `m/12381/8444/2/{index}`) this account bookmarks. */
  index: number;
}

/** One wallet in the registry: identity + display label + its own encrypted record (SW-only). */
export interface WalletEntry {
  /** Stable opaque id (a uuid) — the switch/rename/remove key and the vault's per-wallet key slot. */
  id: string;
  /** User-facing display name. */
  label: string;
  /**
   * This wallet's OWN encrypted DIGWX1 record (the only at-rest secret; never decrypted here).
   * Absent ONLY for a watch-only entry (#96 — {@link kind} `'watch'`), which holds no secret at all.
   */
  record?: Digwx1Record;
  /** Creation timestamp (ms). */
  createdAt: number;
  /**
   * The wallet's single ACTIVE HD derivation index (#165 — one index at a time, prev/next to
   * switch). Default 0. Persisted per wallet so switching wallets restores each one's own place.
   */
  activeIndex: number;
  /**
   * Cached canonical receive address (#176 — the wallet switcher's per-row address preview), PUBLIC
   * data (an address is meant to be shared to receive funds — never the private key), safe to keep
   * unencrypted alongside the metadata. Populated opportunistically by the SW whenever this wallet's
   * index-0 address is read while it is active (see {@link shouldCachePreviewAddress}); absent until
   * then, so an older/never-yet-active wallet simply shows no preview (backwards compatible — an
   * entry persisted before #176 has no `previewAddress` field at all).
   */
  previewAddress?: string;
  /**
   * Named sub-accounts (#95) under this one seed/key — distinct derivation indices with a friendly
   * label. Optional so a pre-#95 persisted entry has none yet; {@link ensureAccounts} synthesizes a
   * single default account (at the wallet's current `activeIndex`) on read.
   */
  accounts?: AccountEntry[];
  /**
   * `'watch'` for a spend-less watch-only wallet imported from a public key only (#96); absent or
   * `'custody'` for an ordinary self-custody wallet holding its own encrypted seed. A watch wallet
   * has NO `record`, NO password, and is never "locked" — every derived view instead reads
   * {@link watchPublicKeyHex} directly, unhardened-scheme only (public-key derivation cannot reach
   * the hardened chain).
   */
  kind?: 'custody' | 'watch';
  /** The watch wallet's master/root BLS public key (hex, 48 bytes / 96 hex chars). Present ONLY
   * when `kind === 'watch'`; every address/balance for this wallet derives from it. */
  watchPublicKeyHex?: string;
  /** The watch wallet's Chia-convention key fingerprint (see `publicKeyFingerprint` in derive.ts) —
   * a short, human-shareable numeric id shown alongside the wallet, cached at import time. */
  watchFingerprint?: number;
}

/** Record-FREE wallet metadata for the UI switcher — the encrypted record is deliberately absent. */
export interface WalletMeta {
  id: string;
  label: string;
  createdAt: number;
  /** True for the currently-active wallet. */
  active: boolean;
  /** This wallet's active HD derivation index (#165). */
  activeIndex: number;
  /** Cached canonical receive address (#176), or absent if never yet cached. */
  previewAddress?: string;
  /** This wallet's named accounts (#95) — always populated (defaulted via {@link ensureAccounts}). */
  accounts: AccountEntry[];
  /** `'watch'` for a spend-less watch-only wallet (#96); absent/`'custody'` for an ordinary wallet. */
  kind?: 'custody' | 'watch';
  /** The watch wallet's key fingerprint (#96), when `kind === 'watch'`. */
  watchFingerprint?: number;
}

/** The normalized registry snapshot the SW persists: the entries, the active id, and the mirror. */
export interface RegistryState {
  wallets: WalletEntry[];
  activeId: string | null;
  /** The active wallet's record (the `wallet.keystore` legacy mirror), or null when there are none. */
  keystore: Digwx1Record | null;
}

/** Inputs to {@link migrateRegistry} — the three storage reads plus a clock + id generator. */
export interface MigrateInput {
  /** The legacy single-wallet `wallet.keystore` blob (pre-#90), or null. */
  legacyKeystore: Digwx1Record | null;
  /** The `wallet.registry` array, or null when it does not exist yet. */
  wallets: WalletEntry[] | null;
  /** The persisted `wallet.activeId`, or null. */
  activeId: string | null;
  /** Current time (ms) for a migrated entry's createdAt fallback. */
  now: number;
  /** Fresh-id generator (the SW passes `crypto.randomUUID`). */
  genId: () => string;
}

/** Trim + clamp a label to {@link MAX_LABEL_LEN}, falling back when it is blank. */
export function normalizeLabel(label: string | undefined | null, fallback: string): string {
  const trimmed = (label ?? '').trim();
  if (!trimmed) return fallback;
  return trimmed.slice(0, MAX_LABEL_LEN);
}

/** The default display name for the Nth wallet (1-based). */
export function defaultLabel(n: number): string {
  return `Wallet ${n}`;
}

/** Append a wallet immutably. */
export function addWallet(wallets: WalletEntry[], entry: WalletEntry): WalletEntry[] {
  return [...wallets, entry];
}

/** Find a wallet by id (or undefined). */
export function findWallet(wallets: WalletEntry[], id: string | null | undefined): WalletEntry | undefined {
  if (!id) return undefined;
  return wallets.find((w) => w.id === id);
}

/** Rename one wallet immutably (metadata only — the record/key are untouched). */
export function renameWallet(wallets: WalletEntry[], id: string, label: string): WalletEntry[] {
  return wallets.map((w) => (w.id === id ? { ...w, label } : w));
}

/** Clamp a candidate derivation index into the valid non-negative bounded range (#165). */
export function clampDerivationIndex(index: number): number {
  if (!Number.isFinite(index)) return 0;
  return Math.min(MAX_DERIVATION_INDEX, Math.max(0, Math.floor(index)));
}

/** Set one wallet's active HD derivation index immutably (#165 — clamped; other wallets untouched). */
export function setWalletActiveIndex(wallets: WalletEntry[], id: string, index: number): WalletEntry[] {
  const clamped = clampDerivationIndex(index);
  return wallets.map((w) => (w.id === id ? { ...w, activeIndex: clamped } : w));
}

/** Remove one wallet immutably. */
export function removeWallet(wallets: WalletEntry[], id: string): WalletEntry[] {
  return wallets.filter((w) => w.id !== id);
}

/** The active wallet's record (for the legacy `wallet.keystore` mirror): active → first → null.
 * `null` for a watch-only active wallet too (it has no record) — callers must not treat that as
 * "no wallet" on its own; check {@link isWatchOnly} first. */
export function activeRecord(wallets: WalletEntry[], activeId: string | null): Digwx1Record | null {
  return (findWallet(wallets, activeId) ?? wallets[0])?.record ?? null;
}

/** True for a spend-less watch-only wallet (#96) — imported from a public key only, no secret. */
export function isWatchOnly(wallet: WalletEntry | undefined | null): boolean {
  return wallet?.kind === 'watch';
}

/** Pick the next active id: keep the preferred id if it still exists, else the first wallet, else null. */
export function nextActiveId(wallets: WalletEntry[], preferred: string | null): string | null {
  if (preferred && findWallet(wallets, preferred)) return preferred;
  return wallets[0]?.id ?? null;
}

/** Project the registry to record-FREE metadata for the UI, flagging the active wallet. Every
 * entry's `accounts` is defaulted via {@link ensureAccounts} so the UI never has to special-case a
 * pre-#95 wallet with none persisted yet. */
export function toMeta(wallets: WalletEntry[], activeId: string | null): WalletMeta[] {
  return wallets.map((w) => ({
    id: w.id,
    label: w.label,
    createdAt: w.createdAt,
    active: w.id === activeId,
    activeIndex: w.activeIndex ?? 0,
    previewAddress: w.previewAddress,
    accounts: ensureAccounts(w),
    ...(w.kind === 'watch' ? { kind: w.kind as 'watch', watchFingerprint: w.watchFingerprint } : {}),
  }));
}

// ── Named accounts (#95 — distinct derivation indices under one seed) ──

/** The default display name for the Nth account (1-based) — mirrors {@link defaultLabel}. */
export function defaultAccountLabel(n: number): string {
  return `Account ${n}`;
}

/**
 * A wallet's accounts, defaulting to ONE synthesized entry at its current `activeIndex` when none
 * are persisted yet (a pre-#95 wallet, or the very first account of a freshly created/imported one).
 * The synthesized id is DETERMINISTIC (`${wallet.id}-acct-0`) rather than random so repeated reads
 * (e.g. every `toMeta` call) are stable — a random id would churn the account's identity every poll.
 */
export function ensureAccounts(wallet: WalletEntry): AccountEntry[] {
  if (wallet.accounts && wallet.accounts.length > 0) return wallet.accounts;
  return [{ id: `${wallet.id}-acct-0`, label: defaultAccountLabel(1), index: wallet.activeIndex ?? 0 }];
}

/**
 * Append a new named account to `walletId`, immutably. The new account's index is one above the
 * HIGHEST index any of the wallet's existing accounts already bookmarks (never just the account
 * COUNT — an account may have been removed, or a prior account may sit at a high index), so a fresh
 * account never collides with one still in use. No-op (returns `wallets` unchanged) for an unknown
 * wallet id.
 */
export function addAccount(wallets: WalletEntry[], walletId: string, label?: string): WalletEntry[] {
  const target = findWallet(wallets, walletId);
  if (!target) return wallets;
  const existing = ensureAccounts(target);
  const nextIndex = Math.max(...existing.map((a) => a.index)) + 1;
  const account: AccountEntry = {
    id: crypto.randomUUID(),
    label: normalizeLabel(label, defaultAccountLabel(existing.length + 1)),
    index: nextIndex,
  };
  return wallets.map((w) => (w.id === walletId ? { ...w, accounts: [...existing, account] } : w));
}

/** Rename one account immutably (metadata only). No-op for an unknown wallet/account id. */
export function renameAccount(wallets: WalletEntry[], walletId: string, accountId: string, label: string): WalletEntry[] {
  return wallets.map((w) => {
    if (w.id !== walletId) return w;
    const accounts = ensureAccounts(w).map((a) => (a.id === accountId ? { ...a, label: normalizeLabel(label, a.label) } : a));
    return { ...w, accounts };
  });
}

/**
 * Remove one account immutably, refusing to drop a wallet's LAST remaining account (returns
 * `wallets` unchanged — a wallet must always have at least one named account). When the removed
 * account was the wallet's currently ACTIVE one (its index === `activeIndex`), re-homes
 * `activeIndex` to the first remaining account so the wallet is never left pointed at a
 * just-deleted account's index with nothing named there anymore.
 */
export function removeAccount(wallets: WalletEntry[], walletId: string, accountId: string): WalletEntry[] {
  const target = findWallet(wallets, walletId);
  if (!target) return wallets;
  const existing = ensureAccounts(target);
  if (existing.length <= 1) return wallets;
  const removed = existing.find((a) => a.id === accountId);
  const accounts = existing.filter((a) => a.id !== accountId);
  if (!removed || accounts.length === existing.length) return wallets; // accountId not found
  const wasActive = removed.index === (target.activeIndex ?? 0);
  return wallets.map((w) =>
    w.id === walletId ? { ...w, accounts, activeIndex: wasActive ? accounts[0].index : w.activeIndex } : w,
  );
}

/** The account (if any) matching the wallet's current `activeIndex`, else `null` — the wallet is
 * pointed at an arbitrary index (via the index navigator) that no named account bookmarks. */
export function activeAccountId(wallet: WalletEntry): string | null {
  return ensureAccounts(wallet).find((a) => a.index === (wallet.activeIndex ?? 0))?.id ?? null;
}

/** Set one wallet's cached preview address immutably (#176 — other wallets untouched). */
export function setWalletPreviewAddress(wallets: WalletEntry[], id: string, address: string): WalletEntry[] {
  return wallets.map((w) => (w.id === id ? { ...w, previewAddress: address } : w));
}

/**
 * True when a freshly-read receive address should be cached onto the active wallet's
 * `previewAddress` (#176): only at derivation index 0 (the wallet's canonical/default address —
 * never whatever non-zero index the user happens to be viewing, which would show a misleadingly
 * "wrong" address for the wallet's identity in the switcher list), only for a non-empty address,
 * and only when it actually differs from what's already cached (skips a redundant storage write).
 */
export function shouldCachePreviewAddress(
  activeIndex: number,
  existing: string | undefined,
  address: string | undefined | null,
): boolean {
  return activeIndex === 0 && !!address && existing !== address;
}

/**
 * Normalize the three storage reads into a coherent {@link RegistryState}:
 *  - an EXISTING registry passes through, with the active id repaired to a real entry (or the first)
 *    and the keystore mirror set to the active record — a stale legacy blob is ignored (no
 *    double-migration);
 *  - otherwise a legacy single `wallet.keystore` is migrated ONCE into a one-entry registry with a
 *    fresh uuid (the pre-#90 `wallet.activeId` held a label, not an id, so it is discarded);
 *  - otherwise (no wallet at all) an empty registry.
 */
export function migrateRegistry(input: MigrateInput): RegistryState {
  const { legacyKeystore, wallets, activeId, now, genId } = input;

  if (Array.isArray(wallets) && wallets.length > 0) {
    // Normalize `activeIndex` on every entry — a registry persisted before #165 has none yet.
    const normalized = wallets.map((w) => ({ ...w, activeIndex: clampDerivationIndex(w.activeIndex ?? 0) }));
    const active = nextActiveId(normalized, activeId);
    return { wallets: normalized, activeId: active, keystore: activeRecord(normalized, active) };
  }

  if (legacyKeystore) {
    const id = genId();
    const entry: WalletEntry = {
      id,
      label: normalizeLabel(legacyKeystore.label, defaultLabel(1)),
      record: legacyKeystore,
      createdAt: typeof legacyKeystore.createdAt === 'number' ? legacyKeystore.createdAt : now,
      activeIndex: 0,
    };
    return { wallets: [entry], activeId: id, keystore: legacyKeystore };
  }

  return { wallets: [], activeId: null, keystore: null };
}
