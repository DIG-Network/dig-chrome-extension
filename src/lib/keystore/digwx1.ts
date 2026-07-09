/**
 * DIGWX1 — the extension's at-rest keystore format (web keystore v1). Encrypts the wallet's
 * BIP-39 ENTROPY under a user password, mirroring `dig-keystore`'s intent (Argon2id + AEAD) with
 * browser-native primitives, so the encrypted blob is the ONLY secret material ever written to
 * disk (`chrome.storage.local` key `wallet.keystore`). The plaintext entropy exists only in the
 * offscreen document's memory after a successful unlock (§5).
 *
 * Crypto (§5.3):
 *  - KDF: Argon2id via `hash-wasm` at dig-keystore's DEFAULT params (64 MiB / 3 iters / 4 lanes),
 *    16-byte random salt. WebCrypto has no Argon2, so the audited wasm lib runs the KDF.
 *    A STRONG preset (256 MiB) is offered for high-value wallets. A `kdfId` byte allows versioned
 *    migration.
 *  - Cipher: AES-256-GCM via native WebCrypto — 12-byte nonce, 128-bit tag. The record HEADER is
 *    bound as AAD (`additionalData`), so tampering with any KDF param, the salt, or the nonce fails
 *    the GCM tag closed with no separate MAC. Fresh salt + nonce on every (re)encryption.
 *  - The derived AES key is imported as a NON-EXTRACTABLE `CryptoKey` (`extractable:false`) and is
 *    never serialized; it is transient within one encrypt/decrypt call here.
 *  - PBKDF2-HMAC-SHA512 (≥600k) is a BOUNDED fallback that engages ONLY when the Argon2 wasm fails
 *    to instantiate (never a silent downgrade): it records `kdfId="pbkdf2"` and the caller surfaces
 *    a warning + schedules forced re-encryption to Argon2 on the next unlock (§5.3).
 *  - Error opacity: any decrypt failure (wrong password, tampered blob) collapses to a single
 *    `KeystoreError('UNLOCK_FAILED')` — no side channel.
 *
 * Pure module (WebCrypto + hash-wasm only; no chrome.* / DOM), so it is unit-tested in Vitest and
 * reused verbatim in the offscreen document. The Argon2 function is injectable purely so the
 * fallback + failure branches are testable without corrupting the wasm module.
 */

import { argon2id } from 'hash-wasm';

/** Fixed record magic + version (bumped only for a NEW writer format; readers stay additive). */
export const MAGIC = 'DIGWX1' as const;
export const VERSION = 1 as const;

/** Supported KDF identifiers. `argon2id` is the default; `pbkdf2` is the bounded fallback only. */
export type KdfId = 'argon2id' | 'pbkdf2';
/** Supported cipher identifiers. */
export type CipherId = 'aes-256-gcm';

/** Argon2id cost parameters (memory in KiB, matching dig-keystore's units). */
export interface Argon2Params {
  memKiB: number;
  iters: number;
  lanes: number;
}

/** dig-keystore DEFAULT: 64 MiB / 3 iterations / 4 lanes (§5.3). */
export const ARGON2_DEFAULT: Argon2Params = { memKiB: 65536, iters: 3, lanes: 4 };
/** STRONG preset for high-value wallets: 256 MiB / 4 iterations / 4 lanes. */
export const ARGON2_STRONG: Argon2Params = { memKiB: 262144, iters: 4, lanes: 4 };
/** PBKDF2 iteration count for the bounded fallback (HMAC-SHA-512). */
export const PBKDF2_ITERS = 600_000;

const AES_KEY_BITS = 256;
const AES_KEY_BYTES = 32;
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const TAG_BITS = 128;

/** The serialized on-disk record. Base64 fields; the header is canonicalized as GCM AAD. */
export interface Digwx1Record {
  version: typeof VERSION;
  magic: typeof MAGIC;
  kdf:
    | { id: 'argon2id'; memKiB: number; iters: number; lanes: number; salt: string }
    | { id: 'pbkdf2'; iters: number; salt: string };
  cipher: { id: CipherId; nonce: string };
  /** base64(entropy ‖ GCM tag). */
  ciphertext: string;
  createdAt: number;
  label?: string;
}

/** Typed keystore error with a stable machine `code` for agent-driveable branching. */
export class KeystoreError extends Error {
  constructor(
    readonly code: 'UNLOCK_FAILED' | 'BAD_RECORD' | 'KDF_UNAVAILABLE',
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'KeystoreError';
  }
}

/** Injectable Argon2id (defaults to hash-wasm) — lets tests exercise the fallback/failure paths. */
export type Argon2Fn = typeof argon2id;

/** Options for {@link encryptEntropy}. */
export interface EncryptOptions {
  /** Argon2 preset (default {@link ARGON2_DEFAULT}). Ignored when the fallback engages. */
  argon2Params?: Argon2Params;
  /** Optional human label stored in the record. */
  label?: string;
  /** Test/DI seam for the Argon2 implementation. */
  argon2Fn?: Argon2Fn;
}

/** Result of an encryption — the record plus whether the PBKDF2 fallback had to engage. */
export interface EncryptResult {
  record: Digwx1Record;
  /** True when Argon2 failed to instantiate and PBKDF2 was used (caller must warn + re-encrypt). */
  usedFallback: boolean;
}

/**
 * Coerce bytes to a definite `ArrayBuffer`-backed view for the WebCrypto `BufferSource` params.
 * TS 5.7's typed arrays are generic (`Uint8Array<ArrayBufferLike>`, where `ArrayBufferLike` admits
 * `SharedArrayBuffer`), which the DOM crypto signatures reject; a fresh copy is unambiguously
 * `Uint8Array<ArrayBuffer>`. The copies here are tiny (keys/salts/nonces/entropy).
 */
const bs = (u: Uint8Array): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(u.byteLength);
  out.set(u);
  return out;
};

const b64encode = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Canonical header serialization used as GCM AAD. Field order is FIXED here (not JSON key order of
 * the record object) so encrypt and decrypt bind the identical bytes regardless of how the record
 * was (de)serialized. Binding {version, magic, full kdf params, cipher id + nonce} means any
 * tamper with those fails the tag closed.
 */
export function canonicalHeader(record: Digwx1Record): Uint8Array {
  const kdf =
    record.kdf.id === 'argon2id'
      ? { id: 'argon2id', memKiB: record.kdf.memKiB, iters: record.kdf.iters, lanes: record.kdf.lanes, salt: record.kdf.salt }
      : { id: 'pbkdf2', iters: record.kdf.iters, salt: record.kdf.salt };
  const canonical = {
    version: record.version,
    magic: record.magic,
    kdf,
    cipher: { id: record.cipher.id, nonce: record.cipher.nonce },
  };
  return new TextEncoder().encode(JSON.stringify(canonical));
}

/** Derive raw 32-byte key material with Argon2id (throws to signal the caller to fall back). */
async function deriveArgon2Key(
  password: string,
  salt: Uint8Array,
  params: Argon2Params,
  argon2Fn: Argon2Fn,
): Promise<Uint8Array> {
  return argon2Fn({
    password,
    salt,
    parallelism: params.lanes,
    iterations: params.iters,
    memorySize: params.memKiB,
    hashLength: AES_KEY_BYTES,
    outputType: 'binary',
  });
}

/** Derive raw 32-byte key material with PBKDF2-HMAC-SHA-512 (the bounded fallback). */
async function derivePbkdf2Key(password: string, salt: Uint8Array, iters: number): Promise<Uint8Array> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-512', salt: bs(salt), iterations: iters },
    base,
    AES_KEY_BITS,
  );
  return new Uint8Array(bits);
}

/** Import raw key bytes as a NON-EXTRACTABLE AES-GCM CryptoKey. */
async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', bs(raw), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/**
 * Encrypt wallet entropy into a DIGWX1 record. Draws a fresh salt + nonce, derives an AES-256 key
 * via Argon2id (or PBKDF2 if Argon2 is unavailable), and AES-GCM-seals the entropy with the record
 * header bound as AAD. The caller writes `record` to `chrome.storage.local` and, if
 * `usedFallback`, warns the user + schedules re-encryption.
 */
export async function encryptEntropy(
  entropy: Uint8Array,
  password: string,
  options: EncryptOptions = {},
): Promise<EncryptResult> {
  const params = options.argon2Params ?? ARGON2_DEFAULT;
  const argon2Fn = options.argon2Fn ?? argon2id;
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));

  let rawKey: Uint8Array;
  let usedFallback = false;
  let kdf: Digwx1Record['kdf'];
  try {
    rawKey = await deriveArgon2Key(password, salt, params, argon2Fn);
    kdf = { id: 'argon2id', memKiB: params.memKiB, iters: params.iters, lanes: params.lanes, salt: b64encode(salt) };
  } catch {
    // Argon2 wasm failed to instantiate — bounded fallback (never a silent downgrade).
    usedFallback = true;
    rawKey = await derivePbkdf2Key(password, salt, PBKDF2_ITERS);
    kdf = { id: 'pbkdf2', iters: PBKDF2_ITERS, salt: b64encode(salt) };
  }

  const record: Digwx1Record = {
    version: VERSION,
    magic: MAGIC,
    kdf,
    cipher: { id: 'aes-256-gcm', nonce: b64encode(nonce) },
    ciphertext: '',
    createdAt: Date.now(),
    ...(options.label ? { label: options.label } : {}),
  };

  const key = await importAesKey(rawKey);
  rawKey.fill(0);
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: bs(nonce), additionalData: bs(canonicalHeader(record)), tagLength: TAG_BITS },
      key,
      bs(entropy),
    ),
  );
  record.ciphertext = b64encode(sealed);
  return { record, usedFallback };
}

/**
 * Shallow structural validation of an UNKNOWN value as a DIGWX1 record — checks the magic/version/
 * kdf/cipher/ciphertext shape only, never touches crypto. Exported (#115) so callers outside this
 * module — the keystore FILE backup/restore parser — can accept-or-reject a file's embedded record
 * before it is ever handed to {@link decryptEntropy}, without duplicating the shape check.
 */
export function isValidDigwx1Record(value: unknown): value is Digwx1Record {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<Digwx1Record>;
  return (
    record.magic === MAGIC &&
    record.version === VERSION &&
    !!record.kdf &&
    !!record.cipher &&
    record.cipher.id === 'aes-256-gcm' &&
    typeof record.ciphertext === 'string'
  );
}

/** Shallow structural validation of a decoded record before we touch crypto. */
function assertRecord(record: Digwx1Record): void {
  if (!isValidDigwx1Record(record)) {
    throw new KeystoreError('BAD_RECORD', 'not a DIGWX1 record');
  }
}

/**
 * Decrypt a DIGWX1 record back to the wallet entropy. Re-derives the key with the record's own
 * `kdf` params (so a PBKDF2-fallback record still opens), then AES-GCM-verifies with the header as
 * AAD. ANY failure — wrong password, tampered params/salt/nonce/ciphertext — surfaces as one opaque
 * `KeystoreError('UNLOCK_FAILED')`; only a structurally-invalid record yields `BAD_RECORD`.
 */
export async function decryptEntropy(
  record: Digwx1Record,
  password: string,
  argon2Fn: Argon2Fn = argon2id,
): Promise<Uint8Array> {
  assertRecord(record);
  try {
    const salt = b64decode(record.kdf.salt);
    let rawKey: Uint8Array;
    if (record.kdf.id === 'argon2id') {
      rawKey = await deriveArgon2Key(
        password,
        salt,
        { memKiB: record.kdf.memKiB, iters: record.kdf.iters, lanes: record.kdf.lanes },
        argon2Fn,
      );
    } else {
      rawKey = await derivePbkdf2Key(password, salt, record.kdf.iters);
    }
    const key = await importAesKey(rawKey);
    rawKey.fill(0);
    const nonce = b64decode(record.cipher.nonce);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bs(nonce), additionalData: bs(canonicalHeader(record)), tagLength: TAG_BITS },
      key,
      bs(b64decode(record.ciphertext)),
    );
    return new Uint8Array(plain);
  } catch (e) {
    if (e instanceof KeystoreError) throw e;
    throw new KeystoreError('UNLOCK_FAILED', 'unlock failed');
  }
}

/** True if a decoded record needs forced re-encryption to Argon2 (a fallback record). */
export function needsUpgrade(record: Digwx1Record): boolean {
  return record.kdf.id === 'pbkdf2';
}
