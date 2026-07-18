/**
 * Persistence for the APP-SIGN pairing record (dig-app `SPEC.md §5.6.3` step 2).
 *
 * After a successful `pair.begin` native confirm, dig-app returns `{ pairing_id, channel_token_b64 }`
 * (the token = base64 of a 32-byte CSPRNG channel secret). The extension stores this in
 * `chrome.storage.local`; every later frame's auth-MAC is keyed by the channel secret and tagged
 * with the pairing id (`auth-frame.ts`).
 *
 * The token grants CHANNEL ACCESS only — it is NEVER sign authority (the terminal native confirm in
 * dig-app binds every sign, §5.6.3/§5.6.5). So although a same-user attacker who can already read
 * `chrome.storage.local` can steal the token, they still cannot mint a signature without the human
 * at dig-app's biometric prompt. We persist the raw token here (matching the spec) and do not
 * pretend browser storage is a secrets vault.
 *
 * This module is chrome-free: it takes an injected {@link KvStore} (the SW passes a thin
 * `chrome.storage.local` adapter), so the whole load/save/clear logic is unit-testable with an
 * in-memory fake and has NO direct chrome.* dependency.
 */

/** The persisted pairing record. `nonce` is the last-issued auth nonce (see `auth-frame.ts`). */
export interface PairingRecord {
  pairingId: string;
  /** base64 of the 32-byte channel secret (dig-app's `channel_token_b64`). */
  channelTokenB64: string;
  /** The last auth nonce issued for this pairing; the next frame uses a strictly greater value. */
  nonce: number;
  /** `Date.now()`-shaped time the pairing was established. */
  pairedAt: number;
}

/** The minimal async key/value surface this store needs (a `chrome.storage.local` subset). */
export interface KvStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

/** The single storage key the pairing record lives under. */
export const PAIRING_STORAGE_KEY = 'appSign.pairing';

/** True when `v` is a structurally-valid persisted pairing record. */
function isPairingRecord(v: unknown): v is PairingRecord {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.pairingId === 'string' &&
    typeof r.channelTokenB64 === 'string' &&
    typeof r.nonce === 'number' &&
    typeof r.pairedAt === 'number'
  );
}

/** A durable store for the one APP-SIGN pairing record. */
export class PairingStore {
  constructor(private readonly kv: KvStore) {}

  /** Load the current pairing record, or null when unpaired / the stored value is malformed. */
  async load(): Promise<PairingRecord | null> {
    const raw = await this.kv.get(PAIRING_STORAGE_KEY);
    return isPairingRecord(raw) ? raw : null;
  }

  /** Persist a freshly-established pairing (nonce starts at 0 — the first frame uses 1). */
  async save(record: Omit<PairingRecord, 'nonce'> & { nonce?: number }): Promise<void> {
    await this.kv.set(PAIRING_STORAGE_KEY, { nonce: 0, ...record });
  }

  /**
   * Persist the last-issued nonce so it keeps strictly increasing across SW restarts. A no-op when
   * unpaired (nothing to attach the nonce to).
   */
  async saveNonce(nonce: number): Promise<void> {
    const current = await this.load();
    if (!current) return;
    await this.kv.set(PAIRING_STORAGE_KEY, { ...current, nonce });
  }

  /** Delete the pairing record — the local half of "unpair" (dig-app deletes its sealed record). */
  async clear(): Promise<void> {
    await this.kv.remove(PAIRING_STORAGE_KEY);
  }
}
