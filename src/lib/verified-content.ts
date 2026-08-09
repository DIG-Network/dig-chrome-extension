// verified-content.ts — the FAIL-CLOSED verify → decrypt tail of a chia:// content read (#2276).
//
// This is the security-critical core of `fetchContentViaRPC` (src/background/index.ts), lifted into a
// pure, dependency-injected module so it can be unit-tested in isolation (the background service worker
// has heavy top-level side effects that make it impractical to import under vitest).
//
// The read path is trustless: content is fetched from an UNTRUSTED serving host (rpc.dig.net / a local
// dig-node), then proven client-side against a CHAIN-anchored root (see trusted-root.ts, #226) before it
// is ever handed to the renderer.
//
// The defect this closes (#2276, mirrors #2264 / #2260): the merkle verdict used to be ADVISORY — a
// failed inclusion proof merely flipped a toolbar badge, and the (cleanly-decrypting) attacker bytes
// still rendered. A compromised/spoofed host could therefore substitute content whenever it also knew a
// valid decryption key. This module makes the verdict LOAD-BEARING: when a trusted root is RESOLVED
// (`trustedRoot !== null`) and the proof does not fold to it, the read is REFUSED — no bytes are returned.
//
// The genuine BLIND case is preserved: when the chain root is unresolvable (`trustedRoot === null`, e.g. a
// rootless URN whose anchor could not be resolved), the content still loads but is reported unverified —
// that path is oblivious by nature and is NOT gated.

import { decideVerified } from './trusted-root';

/**
 * The subset of the shared `dig_client` wasm surface the verify+decrypt tail needs. Injected so tests
 * can supply a deterministic double instead of loading real WASM.
 */
export interface ContentCrypto {
  /** True iff `ciphertext` (+ `proof`) folds to `trustedRoot`. Non-throwing contract; may throw on junk. */
  verifyInclusion(ciphertext: Uint8Array, proof: unknown, trustedRoot: string): boolean;
  /** Derive the per-resource AES-256 key (hex). `salt` is the private-store hex salt, or null (public). */
  deriveKey(storeId: string, resourceKey: string, salt: string | null): string;
  /** Decrypt one AES-256-GCM-SIV ciphertext chunk; throws on tag failure (decoy / wrong key). */
  decryptChunk(keyHex: string, ciphertext: Uint8Array): Uint8Array;
}

/**
 * Decrypt multi-chunk ciphertext. Mirrors decryptResourceChunks() in apps/web/lib/dig-client.js.
 * `chunkLens` are the per-chunk CIPHERTEXT byte lengths (may be null/empty for a single-chunk resource).
 */
export function decryptChunks(
  dig: ContentCrypto,
  keyHex: string,
  ciphertext: Uint8Array,
  chunkLens: number[] | null | undefined,
): Uint8Array {
  const lens = chunkLens && chunkLens.length ? chunkLens : [ciphertext.length];
  if (lens.length === 1) return dig.decryptChunk(keyHex, ciphertext); // fast path
  const lensSum = lens.reduce((a, n) => a + n, 0);
  if (lensSum !== ciphertext.length) {
    throw new Error('served ciphertext length does not match chunk lengths');
  }
  const parts: Uint8Array[] = [];
  let p = 0;
  for (const len of lens) {
    parts.push(dig.decryptChunk(keyHex, ciphertext.subarray(p, p + len)));
    p += len;
  }
  const total = parts.reduce((a, x) => a + x.length, 0);
  const out = new Uint8Array(total);
  let q = 0;
  for (const part of parts) { out.set(part, q); q += part.length; }
  return out;
}

/** Everything the verify+decrypt tail consumes for one resource read. */
export interface VerifyDecryptRequest {
  dig: ContentCrypto;
  /** The served ciphertext for this resource. */
  ciphertext: Uint8Array;
  /** The inclusion proof returned alongside the ciphertext. */
  proof: unknown;
  /** Per-chunk ciphertext byte lengths, or null/empty for a single-chunk resource. */
  chunkLens: number[] | null | undefined;
  /** The chain-derived trusted root, or null when unresolvable (the blind/advisory path). */
  trustedRoot: string | null;
  storeId: string;
  resourceKey: string;
  /** Private-store hex salt, or null for a public store. */
  salt: string | null;
}

/** The decrypted bytes plus the (now load-bearing) verification verdict. */
export interface VerifiedContent {
  bytes: Uint8Array;
  verified: boolean;
}

/**
 * Verify the served ciphertext against the trusted root, then decrypt — FAIL-CLOSED (#2276).
 *
 * Order is deliberate: the inclusion proof is checked and the fail-closed gate is applied BEFORE any
 * decryption, so attacker bytes under a resolved-but-mismatched root are never even decrypted.
 *
 * Throws when:
 *  - a trusted root was RESOLVED but the proof did not fold to it (`DIG_ERR_PROOF_MISMATCH`), or
 *  - decryption fails (GCM-SIV tag failure / decoy / wrong key / chunk-length mismatch →
 *    `DIG_ERR_DECRYPT_TAG`).
 *
 * Returns `{ bytes, verified }` when the read is serveable: either the proof verified against a trusted
 * root (`verified === true`), or there was no resolvable trusted root (`trustedRoot === null` → the blind
 * advisory path, `verified === false`, bytes still returned).
 */
export function verifyAndDecrypt(req: VerifyDecryptRequest): VerifiedContent {
  // 1. Verify merkle inclusion against the TRUSTED root (non-throwing; decoys/tamper return false).
  //    With no resolvable trusted root, `verified` is false regardless of what the host returned.
  let proofOk = false;
  if (req.trustedRoot) {
    try {
      proofOk = !!req.dig.verifyInclusion(req.ciphertext, req.proof, req.trustedRoot);
    } catch {
      proofOk = false;
    }
  }
  const verified = decideVerified(req.trustedRoot, proofOk);

  // 2. FAIL-CLOSED (#2276): a RESOLVED trusted root that did not verify MUST refuse — never return the
  //    served bytes. The blind case (trustedRoot === null) is exempt and stays advisory (step 4 below).
  if (req.trustedRoot !== null && !verified) {
    throw new Error('inclusion proof failed to verify against the trusted on-chain root (fail-closed refusal)');
  }

  // 3. Decrypt (GCM-SIV tag failure = decoy or wrong key → throw, caller shows error).
  const keyHex = req.dig.deriveKey(req.storeId, req.resourceKey, req.salt);
  let bytes: Uint8Array;
  try {
    bytes = decryptChunks(req.dig, keyHex, req.ciphertext, req.chunkLens);
  } catch {
    throw new Error('decrypt failed (decoy or wrong key)');
  }

  // 4. Serveable: verified against a trusted root, OR the legitimate blind path (verified === false).
  return { bytes, verified };
}
