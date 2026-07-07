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

/**
 * Upper bound on a persisted active derivation index (#165) — a sanity clamp, not a scan gap limit
 * (the single-active-index model derives exactly ONE index at a time, never a range). Generous
 * enough for any realistic HD usage while rejecting nonsense input (e.g. `Number.MAX_SAFE_INTEGER`).
 */
export const MAX_DERIVATION_INDEX = 1_000_000;

/** One wallet in the registry: identity + display label + its own encrypted record (SW-only). */
export interface WalletEntry {
  /** Stable opaque id (a uuid) — the switch/rename/remove key and the vault's per-wallet key slot. */
  id: string;
  /** User-facing display name. */
  label: string;
  /** This wallet's OWN encrypted DIGWX1 record (the only at-rest secret; never decrypted here). */
  record: Digwx1Record;
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

/** The active wallet's record (for the legacy `wallet.keystore` mirror): active → first → null. */
export function activeRecord(wallets: WalletEntry[], activeId: string | null): Digwx1Record | null {
  return (findWallet(wallets, activeId) ?? wallets[0])?.record ?? null;
}

/** Pick the next active id: keep the preferred id if it still exists, else the first wallet, else null. */
export function nextActiveId(wallets: WalletEntry[], preferred: string | null): string | null {
  if (preferred && findWallet(wallets, preferred)) return preferred;
  return wallets[0]?.id ?? null;
}

/** Project the registry to record-FREE metadata for the UI, flagging the active wallet. */
export function toMeta(wallets: WalletEntry[], activeId: string | null): WalletMeta[] {
  return wallets.map((w) => ({
    id: w.id,
    label: w.label,
    createdAt: w.createdAt,
    active: w.id === activeId,
    activeIndex: w.activeIndex ?? 0,
    previewAddress: w.previewAddress,
  }));
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
