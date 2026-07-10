/**
 * DIGWX1 — the extension's at-rest keystore format. Encrypts the wallet's BIP-39 ENTROPY under a
 * user password so the encrypted blob is the ONLY secret material ever written to disk
 * (`chrome.storage.local` key `wallet.keystore`). The plaintext entropy exists only in the
 * offscreen document's memory after a successful unlock (§5).
 *
 * Two record versions share the `DIGWX1` magic:
 *
 *  - **V2 (current writer, dig_ecosystem #147 Phase B):** delegates ALL crypto to the canonical
 *    `dig-keystore` crate's `opaque` module via its wasm binding (`@dignetwork/dig-keystore-wasm`
 *    — Argon2id + AES-256-GCM, the SAME audited implementation every other DIG binary's keystore
 *    file uses), instead of hand-rolling the primitives in JS. `ciphertext` holds base64 of the
 *    binding's `seal()`/`sealStrong()` output — a self-describing container (its own header
 *    carries the KDF params/salt/nonce/AAD binding), so this record's own `kdf`/`cipher` fields are
 *    placeholders (`'dig-keystore-opaque'`) and carry no crypto parameters of their own.
 *  - **V1 (legacy, DECODE-ONLY):** the extension's original hand-rolled Argon2id (via `hash-wasm`)
 *    + native WebCrypto AES-256-GCM, with a PBKDF2-HMAC-SHA512 bounded fallback for when the
 *    Argon2 wasm failed to instantiate. {@link encryptEntropyLegacyV1} still WRITES this format
 *    (kept for fixture generation / regression coverage of the decode path); no production call
 *    site writes it anymore. {@link decryptEntropy} decodes it FOREVER — an existing user's vault
 *    (encrypted before this extension migrated to V2) MUST keep opening, per §5.1's backwards-
 *    compatibility spirit for permanent at-rest formats.
 *
 * Crypto (V1, §5.3 — decode-only from here on):
 *  - KDF: Argon2id via `hash-wasm` at dig-keystore's DEFAULT params (64 MiB / 3 iters / 4 lanes),
 *    16-byte random salt. A STRONG preset (256 MiB) was offered for high-value wallets.
 *  - Cipher: AES-256-GCM via native WebCrypto — 12-byte nonce, 128-bit tag. The record HEADER is
 *    bound as AAD (`additionalData`), so tampering with any KDF param, the salt, or the nonce fails
 *    the GCM tag closed with no separate MAC.
 *  - The derived AES key is imported as a NON-EXTRACTABLE `CryptoKey` (`extractable:false`) and is
 *    never serialized; it is transient within one decrypt call here.
 *  - PBKDF2-HMAC-SHA512 (≥600k) was a BOUNDED fallback that engaged ONLY when the Argon2 wasm
 *    failed to instantiate; `decryptEntropy` still opens a PBKDF2-fallback V1 record.
 *  - Error opacity: any decrypt failure (wrong password, tampered blob) collapses to a single
 *    `KeystoreError('UNLOCK_FAILED')` — no side channel. Preserved identically for V2.
 *
 * Pure module (WebCrypto + hash-wasm for the V1 decode path only; no chrome.* / DOM / direct wasm
 * import), so it is unit-tested in Vitest and reused verbatim in the offscreen document. The
 * dig-keystore-wasm surface is INJECTED (see {@link KeystoreWasm}) rather than imported here — the
 * real wasm module is loaded only at the offscreen-document runtime edge
 * (`src/entries/offscreen.ts`), mirroring how `chia-wallet-sdk-wasm` is handled elsewhere in this
 * vault — so this module never needs Vite's wasm-bundling plugins to be unit-testable. The Argon2
 * function is likewise injectable purely so the V1 fallback + failure branches are testable
 * without corrupting the wasm module.
 */

import { argon2id } from 'hash-wasm';

/** Fixed record magic. Shared by both record versions (see the module doc). */
export const MAGIC = 'DIGWX1' as const;
/** Legacy (decode-only) writer format version — hand-rolled Argon2id/AES-GCM. */
export const VERSION = 1 as const;
/** Current writer format version — dig-keystore-wasm-backed (dig_ecosystem #147 Phase B). */
export const VERSION_V2 = 2 as const;

/**
 * The `dig-keystore-wasm` surface this module needs (`@dignetwork/dig-keystore-wasm`'s `seal`/
 * `sealStrong`/`open` exports). Injected (never imported directly here — see the module doc);
 * `src/entries/offscreen.ts` lazily loads the real module and supplies it via {@link VaultDeps}
 * (`src/offscreen/vault.ts`), mirroring `loadChiaWasm`/`deps.chia`.
 */
export interface KeystoreWasm {
  /** DEFAULT preset (64 MiB/3/4). Throws (rejects) on internal failure — see the wasm crate's docs. */
  seal(password: string, secret: Uint8Array): Uint8Array;
  /** STRONG preset (256 MiB/4/4) — the extension's high-value-wallet option. */
  sealStrong(password: string, secret: Uint8Array): Uint8Array;
  /** Throws (rejects) with a plain-string error on wrong password, tampering, or a non-opaque blob. */
  open(password: string, blob: Uint8Array): Uint8Array;
}

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

/** The legacy (V1, decode-only) serialized on-disk record. Base64 fields; the header is
 * canonicalized as GCM AAD. See the module doc — no production writer emits this anymore. */
export interface Digwx1RecordV1 {
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

/**
 * The current (V2) serialized on-disk record — dig-keystore-wasm-backed (see the module doc).
 * `kdf`/`cipher` are placeholders (the real KDF params/cipher/salt/nonce live inside the
 * self-describing wasm-binding container); only `ciphertext` carries crypto material.
 */
export interface Digwx1RecordV2 {
  version: typeof VERSION_V2;
  magic: typeof MAGIC;
  kdf: { id: 'dig-keystore-opaque' };
  cipher: { id: 'dig-keystore-opaque' };
  /** base64(the dig-keystore-wasm `seal`/`sealStrong` output — a complete, self-describing
   * container: header (KDF params, salt, nonce) + AES-256-GCM ciphertext+tag + CRC-32). */
  ciphertext: string;
  createdAt: number;
  label?: string;
}

/** Either record version — the `chrome.storage.local`-persisted shape callers pass around
 * opaquely (wallet registry, backup export/import); {@link decryptEntropy} dispatches on
 * `.version`. */
export type Digwx1Record = Digwx1RecordV1 | Digwx1RecordV2;

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

/** Injectable Argon2id (defaults to hash-wasm) — lets tests exercise the V1 fallback/failure paths. */
export type Argon2Fn = typeof argon2id;

/** Options for {@link encryptEntropyLegacyV1}. */
export interface EncryptOptionsLegacyV1 {
  /** Argon2 preset (default {@link ARGON2_DEFAULT}). Ignored when the fallback engages. */
  argon2Params?: Argon2Params;
  /** Optional human label stored in the record. */
  label?: string;
  /** Test/DI seam for the Argon2 implementation. */
  argon2Fn?: Argon2Fn;
}

/** Options for {@link encryptEntropy} (the production, V2, dig-keystore-wasm-backed writer). */
export interface EncryptOptions {
  /** Use the STRONG (256 MiB) dig-keystore-wasm preset instead of DEFAULT (64 MiB) — the
   * extension's high-value-wallet option (mirrors the legacy {@link ARGON2_STRONG} preset). */
  strong?: boolean;
  /** Optional human label stored in the record. */
  label?: string;
  /** The dig-keystore-wasm surface — REQUIRED (supplied by the offscreen runtime via
   * `VaultDeps.keystoreWasm`; injected directly in tests). Never defaulted/imported here — see
   * the module doc for why this module stays wasm-import-free. */
  keystoreWasm: KeystoreWasm;
}

/** Result of an encryption — the record plus whether the legacy PBKDF2 fallback had to engage. */
export interface EncryptResult {
  record: Digwx1Record;
  /** True when the V1 writer's Argon2 failed to instantiate and PBKDF2 was used instead (caller
   * must warn + re-encrypt). Always `false` from {@link encryptEntropy} (the V2 writer) — kept on
   * the wire shape for API stability with existing callers (`vault.ts`/`background/index.ts`
   * already thread it through); the JS-side Argon2→PBKDF2 fallback concept doesn't apply to the
   * wasm-backed writer, since `dig-keystore-wasm` is a small, offline, same-origin bundled asset
   * (like `chia-wallet-sdk-wasm` elsewhere in this vault) rather than a resource that plausibly
   * fails to instantiate the way the old in-browser Argon2 sometimes did. */
  usedFallback: boolean;
}

/** Result of {@link encryptEntropyLegacyV1} — precisely V1-typed (unlike the general
 * {@link EncryptResult}) since that writer only ever produces a V1 record. */
export interface EncryptResultLegacyV1 {
  record: Digwx1RecordV1;
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
export function canonicalHeader(record: Digwx1RecordV1): Uint8Array {
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
 * Encrypt wallet entropy into a V2 DIGWX1 record — the PRODUCTION writer (dig_ecosystem #147
 * Phase B). Delegates entirely to `dig-keystore-wasm`'s `seal`/`sealStrong` (the canonical
 * `dig-keystore` crate's Argon2id + AES-256-GCM `opaque` container) instead of hand-rolling the
 * primitives in JS; the caller writes `record` to `chrome.storage.local` as before.
 */
export async function encryptEntropy(
  entropy: Uint8Array,
  password: string,
  options: EncryptOptions,
): Promise<EncryptResult> {
  const blob = options.strong
    ? options.keystoreWasm.sealStrong(password, entropy)
    : options.keystoreWasm.seal(password, entropy);
  const record: Digwx1RecordV2 = {
    version: VERSION_V2,
    magic: MAGIC,
    kdf: { id: 'dig-keystore-opaque' },
    cipher: { id: 'dig-keystore-opaque' },
    ciphertext: b64encode(blob),
    createdAt: Date.now(),
    ...(options.label ? { label: options.label } : {}),
  };
  return { record, usedFallback: false };
}

/**
 * **Legacy (V1), decode-compat only.** The extension's original hand-rolled writer — Argon2id (via
 * `hash-wasm`, with a bounded PBKDF2 fallback) + native WebCrypto AES-256-GCM. NO production call
 * site writes this format anymore (see the module doc); kept exported for test-fixture generation
 * and regression coverage of the decode path {@link decryptEntropy} must keep supporting forever.
 * Draws a fresh salt + nonce, derives an AES-256 key via Argon2id (or PBKDF2 if Argon2 is
 * unavailable), and AES-GCM-seals the entropy with the record header bound as AAD.
 */
export async function encryptEntropyLegacyV1(
  entropy: Uint8Array,
  password: string,
  options: EncryptOptionsLegacyV1 = {},
): Promise<EncryptResultLegacyV1> {
  const params = options.argon2Params ?? ARGON2_DEFAULT;
  const argon2Fn = options.argon2Fn ?? argon2id;
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));

  let rawKey: Uint8Array;
  let usedFallback = false;
  let kdf: Digwx1RecordV1['kdf'];
  try {
    rawKey = await deriveArgon2Key(password, salt, params, argon2Fn);
    kdf = { id: 'argon2id', memKiB: params.memKiB, iters: params.iters, lanes: params.lanes, salt: b64encode(salt) };
  } catch {
    // Argon2 wasm failed to instantiate — bounded fallback (never a silent downgrade).
    usedFallback = true;
    rawKey = await derivePbkdf2Key(password, salt, PBKDF2_ITERS);
    kdf = { id: 'pbkdf2', iters: PBKDF2_ITERS, salt: b64encode(salt) };
  }

  const record: Digwx1RecordV1 = {
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
  const record = value as {
    magic?: unknown;
    version?: unknown;
    kdf?: unknown;
    cipher?: { id?: unknown };
    ciphertext?: unknown;
  };
  if (record.magic !== MAGIC || !record.kdf || !record.cipher || typeof record.ciphertext !== 'string') {
    return false;
  }
  if (record.version === VERSION) return record.cipher.id === 'aes-256-gcm';
  if (record.version === VERSION_V2) return record.cipher.id === 'dig-keystore-opaque';
  return false;
}

/** Shallow structural validation of a decoded record before we touch crypto. */
function assertRecord(record: Digwx1Record): void {
  if (!isValidDigwx1Record(record)) {
    throw new KeystoreError('BAD_RECORD', 'not a DIGWX1 record');
  }
}

/** Options for {@link decryptEntropy}. */
export interface DecryptOptions {
  /** Test/DI seam for the LEGACY (V1) Argon2id implementation (defaults to the real hash-wasm).
   * Unused when opening a V2 record. */
  argon2Fn?: Argon2Fn;
  /** The dig-keystore-wasm surface — REQUIRED to open a V2 record (throws `KDF_UNAVAILABLE` if
   * absent); unused when opening a legacy V1 record, so callers that only ever pass V1 records
   * (rare — pre-migration test fixtures) may omit it. */
  keystoreWasm?: KeystoreWasm;
}

/**
 * Decrypt a DIGWX1 record back to the wallet entropy — dispatches on `record.version` so an
 * EXISTING user's pre-migration V1 vault keeps opening forever (dig_ecosystem #147 Phase B
 * backwards-compatibility requirement) alongside the current V2 format:
 *
 *  - **V2:** delegates to `options.keystoreWasm.open` — the wasm binding's own container decode +
 *    KDF re-derivation + AES-GCM verification (§ the module doc).
 *  - **V1 (legacy):** re-derives the key with the record's own `kdf` params (so a PBKDF2-fallback
 *    record still opens), then AES-GCM-verifies with the header as AAD — unchanged from the
 *    extension's original implementation.
 *
 * ANY failure — wrong password, tampered params/salt/nonce/ciphertext — surfaces as one opaque
 * `KeystoreError('UNLOCK_FAILED')`; only a structurally-invalid record yields `BAD_RECORD`.
 */
export async function decryptEntropy(
  record: Digwx1Record,
  password: string,
  options: DecryptOptions = {},
): Promise<Uint8Array> {
  assertRecord(record);
  if (record.version === VERSION_V2) {
    if (!options.keystoreWasm) {
      throw new KeystoreError('KDF_UNAVAILABLE', 'dig-keystore-wasm required to open a V2 record');
    }
    try {
      return options.keystoreWasm.open(password, b64decode(record.ciphertext));
    } catch (e) {
      if (e instanceof KeystoreError) throw e;
      throw new KeystoreError('UNLOCK_FAILED', 'unlock failed');
    }
  }
  return decryptEntropyLegacyV1(record, password, options.argon2Fn ?? argon2id);
}

/** The legacy (V1) decode path — unchanged from the extension's original implementation. Split out
 * so {@link decryptEntropy} can dispatch to it for a pre-migration record while a V2 record takes
 * the wasm-binding path above. */
async function decryptEntropyLegacyV1(
  record: Digwx1RecordV1,
  password: string,
  argon2Fn: Argon2Fn,
): Promise<Uint8Array> {
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

/** True if a decoded record is not yet on the current canonical (V2, dig-keystore-wasm-backed)
 * format — either a legacy V1 record written before dig_ecosystem #147 Phase B (any KDF), or
 * specifically a V1 PBKDF2-fallback record. Callers MAY re-encrypt via {@link encryptEntropy} on
 * next successful unlock to modernize the at-rest format; nothing currently forces this (V1 stays
 * readable forever regardless). */
export function needsUpgrade(record: Digwx1Record): boolean {
  return record.version === VERSION;
}
