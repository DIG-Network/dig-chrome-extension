/**
 * Local key-material PURGE (#374, safety rule 4) — the auditable, PER-WALLET scoped removal of the
 * extension's self-custody secret once the node is proven to custody + sign for a SPECIFIC wallet
 * (`node-migration.ts`). After the whole cutover completes the extension holds NO key material — only
 * the paired control token + non-secret prefs/caches.
 *
 * # Multi-wallet safety (CRITICAL — the fund-loss bug this design closes)
 * The extension is MULTI-wallet: `wallet.registry` is a `WalletEntry[]`, each entry carrying its OWN
 * encrypted DIGWX1 `record`, with `wallet.keystore` a mirror of only the ACTIVE wallet. A purge MUST
 * NEVER delete the whole `wallet.registry` in one shot — that would destroy the seeds of wallets the
 * node was never sent and cannot sign for (PERMANENT fund loss). Instead {@link purgeWalletFromRegistry}
 * removes ONLY the one verified wallet's entry and recomputes what remains; the wholesale teardown of
 * the registry/mirror/active-id keys happens ONLY when NO entry remains at all.
 *
 * The key constants are IMPORTED from the modules that own them so the purge can never drift from
 * where the secret lives. PURE decision (`purgeWalletFromRegistry`) + an injected-I/O executor
 * (`applyScopedPurge`), so both the scoping and the persistence are unit-tested.
 */

import { KEYSTORE_KEY, ACTIVE_WALLET_KEY, UNLOCK_EXPIRY_KEY } from './custody-session';
import {
  WALLETS_KEY,
  removeWallet,
  nextActiveId,
  activeRecord,
  type WalletEntry,
} from './wallet-registry';
import type { Digwx1Record } from './keystore/digwx1';

/**
 * `chrome.storage.local` keys removed WHOLESALE ONLY on the final teardown — when the registry is
 * empty (no entries remain): the DIGWX1 keystore mirror, the whole registry array, and the active-id
 * pointer. While ANY entry remains, the registry is REWRITTEN (minus the purged entry), never removed.
 */
export const TEARDOWN_LOCAL_KEYS: readonly string[] = [KEYSTORE_KEY, WALLETS_KEY, ACTIVE_WALLET_KEY];

/** `chrome.storage.session` keys tied to a live unlock (the non-secret unlock-expiry) — cleared on purge. */
export const TEARDOWN_SESSION_KEYS: readonly string[] = [UNLOCK_EXPIRY_KEY];

/** The PURE result of scoping a purge to one wallet — what the SW must persist. */
export interface ScopedPurgeResult {
  /** The registry AFTER removing the verified wallet's entry (every other wallet untouched). */
  remaining: WalletEntry[];
  /** The recomputed active-wallet id over what remains (null when nothing remains). */
  activeId: string | null;
  /** The new `wallet.keystore` mirror (the active remaining wallet's record), or null to remove the mirror. */
  keystoreMirror: Digwx1Record | null;
  /**
   * True when NO entry remains at all — the SW then removes {@link TEARDOWN_LOCAL_KEYS} +
   * {@link TEARDOWN_SESSION_KEYS} wholesale and zeroizes the vault. This is the ONLY path that removes
   * the whole `wallet.registry` key.
   */
  fullTeardown: boolean;
}

/**
 * Scope a purge to ONLY `walletId`'s key material (safety rule 1 — never over-purge). Removes that one
 * entry (its encrypted record) from the registry immutably, recomputes the active id + the keystore
 * mirror over what remains, and reports whether the registry is now empty (→ full teardown). A wallet
 * the node was NOT proven to custody remains locally intact. Reuses the audited registry transforms
 * (`removeWallet`/`nextActiveId`/`activeRecord`) rather than hand-rolling array surgery.
 */
export function purgeWalletFromRegistry(
  wallets: WalletEntry[],
  activeId: string | null,
  walletId: string,
): ScopedPurgeResult {
  const remaining = removeWallet(wallets, walletId);
  if (remaining.length === 0) {
    return { remaining, activeId: null, keystoreMirror: null, fullTeardown: true };
  }
  const newActiveId = nextActiveId(remaining, activeId);
  return {
    remaining,
    activeId: newActiveId,
    keystoreMirror: activeRecord(remaining, newActiveId),
    fullTeardown: false,
  };
}

/** The injected effects the purge executor performs (all storage/vault I/O lives here). */
export interface ScopedPurgeDeps {
  /** Write the given `chrome.storage.local` items. */
  setLocal: (items: Record<string, unknown>) => Promise<void>;
  /** Remove the given keys from `chrome.storage.local`. */
  removeLocal: (keys: readonly string[]) => Promise<void>;
  /** Remove the given keys from `chrome.storage.session` (a no-op where session is absent). */
  removeSession: (keys: readonly string[]) => Promise<void>;
  /**
   * Best-effort: tell the offscreen vault to zeroize its in-memory decrypted key. MUST NOT throw (the
   * offscreen doc may already be gone) — the at-rest write/remove is the durable guarantee.
   */
  zeroizeVault?: () => Promise<void>;
}

/**
 * Persist a {@link ScopedPurgeResult}. Full teardown (nothing remains) removes every key-material key
 * wholesale; otherwise the registry is REWRITTEN minus the purged entry, the mirror is updated (or
 * removed when no custody record is active), and the unlock window is cleared (forcing re-unlock of
 * the new active wallet). The vault is zeroized best-effort in both cases so no decrypted key lingers.
 * Idempotent — safe to re-run.
 */
export async function applyScopedPurge(result: ScopedPurgeResult, deps: ScopedPurgeDeps): Promise<void> {
  if (deps.zeroizeVault) await deps.zeroizeVault().catch(() => {});
  if (result.fullTeardown) {
    await deps.removeLocal(TEARDOWN_LOCAL_KEYS);
    await deps.removeSession(TEARDOWN_SESSION_KEYS);
    return;
  }
  await deps.setLocal({ [WALLETS_KEY]: result.remaining, [ACTIVE_WALLET_KEY]: result.activeId });
  if (result.keystoreMirror) await deps.setLocal({ [KEYSTORE_KEY]: result.keystoreMirror });
  else await deps.removeLocal([KEYSTORE_KEY]);
  await deps.removeSession(TEARDOWN_SESSION_KEYS);
}
