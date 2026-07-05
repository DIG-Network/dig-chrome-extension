import { storageGet, storageSet } from '@/lib/messaging';

/** `chrome.storage.local` key for the durable wallet settings blob (shared with the SW). */
export const SETTINGS_KEY = 'wallet.settings';

/** The wallet settings the custody surfaces read/write (a subset of `wallet.settings`). */
export interface WalletSettings {
  /** Chain RPC override (§5.3 custom node); empty → the SW uses the coinset default. */
  chainRpcUrl?: string;
  /** Whether the user has acknowledged the balance-scan privacy note. */
  chainPrivacyAck?: boolean;
  /** Unlock TTL in minutes. */
  unlockTtlMinutes?: number;
  [k: string]: unknown;
}

/** Read the durable wallet settings blob (`{}` when unset). */
export async function readWalletSettings(): Promise<WalletSettings> {
  const out = await storageGet<{ [SETTINGS_KEY]: WalletSettings }>(SETTINGS_KEY);
  return out[SETTINGS_KEY] ?? {};
}

/** Merge a patch into the wallet settings (read-modify-write) so unrelated fields survive. */
export async function updateWalletSettings(patch: Partial<WalletSettings>): Promise<WalletSettings> {
  const current = await readWalletSettings();
  const next = { ...current, ...patch };
  await storageSet({ [SETTINGS_KEY]: next });
  return next;
}
