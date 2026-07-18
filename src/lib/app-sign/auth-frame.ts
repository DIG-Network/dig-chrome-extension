/**
 * Per-frame authentication for the APP-SIGN paired channel (dig-app `SPEC.md §5.6.3`).
 *
 * After pairing, EVERY request frame the extension sends carries an `auth` object:
 *
 *   ```
 *   "auth": { "pairing_id": <uuid>, "nonce": <u64>, "mac_b64": <base64> }
 *   ```
 *
 * where
 *   `mac_b64 = base64( HMAC-SHA256( channel_secret, canonical_frame_bytes ) )`
 *   `canonical_frame_bytes = utf8(nonce_decimal) ‖ 0x00 ‖ utf8(method) ‖ 0x00 ‖ canonical_json(params)`
 *
 * `nonce` is a STRICTLY MONOTONIC per-pairing `u64` — dig-app rejects any nonce ≤ the last accepted
 * one (`AUTH_REPLAY`), which bars replay of a captured frame. The MAC binds the nonce, the method,
 * and the exact canonical params together, so a MITM cannot re-target a signed frame at a different
 * method or mutate its params without invalidating the MAC (`AUTH_BAD_MAC`).
 *
 * The construction MUST be byte-identical to dig-app's (it is the cross-repo contract). The two
 * 0x00 separators are UNAMBIGUOUS delimiters: because a decimal nonce and a JSON method name never
 * contain a NUL byte, no `(nonce, method, params)` triple can collide with another under the MAC.
 *
 * This module owns the framing + MAC only. HMAC-SHA256 is delegated to an injected primitive
 * (`hmacSha256`) so the module is unit-testable with a deterministic fake and the SW wires the real
 * WebCrypto `SubtleCrypto.sign('HMAC', …)`. The default primitive uses `globalThis.crypto.subtle`.
 */

import { canonicalJson, type CanonicalJsonValue } from './canonical-json';

/** The `auth` object attached to every post-pairing request frame (§5.6.3). */
export interface AuthObject {
  pairing_id: string;
  nonce: number;
  mac_b64: string;
}

/** An HMAC-SHA256 primitive: `mac = HMAC(key, message)`. Injected so the framing is testable. */
export type HmacSha256 = (key: Uint8Array, message: Uint8Array) => Promise<Uint8Array>;

/** ASCII NUL — the unambiguous field separator in `canonical_frame_bytes`. */
const NUL = 0x00;

/**
 * Assemble the exact bytes the MAC is computed over (§5.6.3):
 * `utf8(nonce_decimal) ‖ 0x00 ‖ utf8(method) ‖ 0x00 ‖ canonical_json(params)`.
 *
 * Exported so a conformance test can assert the framing byte-for-byte independently of the MAC.
 */
export function canonicalFrameBytes(nonce: number, method: string, params: CanonicalJsonValue): Uint8Array {
  const enc = new TextEncoder();
  const nonceBytes = enc.encode(String(nonce));
  const methodBytes = enc.encode(method);
  const paramsBytes = enc.encode(canonicalJson(params));

  const frame = new Uint8Array(nonceBytes.length + 1 + methodBytes.length + 1 + paramsBytes.length);
  let offset = 0;
  frame.set(nonceBytes, offset);
  offset += nonceBytes.length;
  frame[offset++] = NUL;
  frame.set(methodBytes, offset);
  offset += methodBytes.length;
  frame[offset++] = NUL;
  frame.set(paramsBytes, offset);
  return frame;
}

/** Base64-encode bytes (standard alphabet, with padding) — the `mac_b64` / channel-token encoding. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** Decode a standard-alphabet base64 string to bytes (inverse of {@link bytesToBase64}). */
export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Build the `auth` object for a `(pairing_id, nonce, method, params)` frame using `channelSecret`
 * as the HMAC key. The caller owns nonce monotonicity (see {@link NonceCounter}); this function is
 * pure w.r.t. its inputs and the injected `hmac`.
 */
export async function buildAuth(
  {
    pairingId,
    channelSecret,
    nonce,
    method,
    params,
  }: { pairingId: string; channelSecret: Uint8Array; nonce: number; method: string; params: CanonicalJsonValue },
  hmac: HmacSha256 = webCryptoHmacSha256,
): Promise<AuthObject> {
  const mac = await hmac(channelSecret, canonicalFrameBytes(nonce, method, params));
  return { pairing_id: pairingId, nonce, mac_b64: bytesToBase64(mac) };
}

/**
 * A strictly-monotonic per-pairing nonce source. Seeds from the last-used nonce (0 for a fresh
 * pairing) so nonces keep increasing across SW restarts once the caller persists {@link value}.
 * `next()` returns a value STRICTLY GREATER than every prior one from this counter.
 */
export class NonceCounter {
  private last: number;

  constructor(seed = 0) {
    this.last = Math.max(0, Math.floor(seed));
  }

  /** The last nonce handed out — persist this so a later counter can resume above it. */
  get value(): number {
    return this.last;
  }

  /** Return the next nonce (strictly greater than the previous). */
  next(): number {
    this.last += 1;
    return this.last;
  }
}

/** The default HMAC-SHA256 primitive, backed by WebCrypto `SubtleCrypto`. */
export async function webCryptoHmacSha256(key: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await globalThis.crypto.subtle.importKey(
    'raw',
    key as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await globalThis.crypto.subtle.sign('HMAC', cryptoKey, message as BufferSource);
  return new Uint8Array(sig);
}
