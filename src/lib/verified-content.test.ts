/**
 * Fail-closed content verification (#2276) — the security-critical verify → decrypt tail of a chia://
 * read. Property under test: a RESOLVED trusted root whose inclusion proof does NOT verify must REFUSE
 * to return bytes, even when the served ciphertext decrypts cleanly (a spoofed/compromised host that
 * also knows a valid key). The nearest wrong implementation is the pre-#2276 behaviour: return the
 * cleanly-decrypting bytes with `verified: false` (advisory badge only). These tests distinguish the
 * two by asserting NO bytes are returned (a throw), which the advisory implementation cannot satisfy.
 *
 * The controls that keep the strong (refusal) case honest:
 *  - a resolved trusted root whose proof VERIFIES still returns bytes (the fix must not break the happy
 *    path — the nearest wrong "always refuse" implementation fails this);
 *  - a null trusted root (unresolvable chain anchor) with the SAME decrypting bytes still serves
 *    advisory (the fix must not gate the legitimate blind path — an over-broad gate fails this).
 */
import { describe, it, expect, vi } from 'vitest';
import { verifyAndDecrypt, decryptChunks, type ContentCrypto } from './verified-content';

// A concrete 64-hex root — the shape `resolveReadRoots`/`resolveAnchoredRoot` produce for a resolved
// trusted root (a rooted URN's pin, or a rootless URN's chain-anchored tip).
const TRUSTED_ROOT = 'a'.repeat(64);

/** Plaintext the fake decrypt yields — the "attacker bytes" that must NOT reach the renderer on refusal. */
const PLAINTEXT = new TextEncoder().encode('<html>attacker-substituted content</html>');
const CIPHERTEXT = new Uint8Array([1, 2, 3, 4]); // opaque; the doubles below don't inspect its contents.

/**
 * Build a crypto double. `inclusionVerifies` controls the merkle verdict; decryption always SUCCEEDS
 * (returns PLAINTEXT) unless `decryptThrows` — so the refusal cannot be attributed to a decrypt failure.
 */
function makeDig(opts: {
  inclusionVerifies: boolean;
  decryptThrows?: boolean;
  verifyThrows?: boolean;
}): ContentCrypto {
  return {
    verifyInclusion: vi.fn(() => {
      if (opts.verifyThrows) throw new Error('malformed proof');
      return opts.inclusionVerifies;
    }),
    deriveKey: vi.fn(() => 'deadbeef'.repeat(8)),
    decryptChunk: vi.fn(() => {
      if (opts.decryptThrows) throw new Error('gcm tag failed');
      return PLAINTEXT;
    }),
  };
}

const baseReq = (dig: ContentCrypto, trustedRoot: string | null) => ({
  dig,
  ciphertext: CIPHERTEXT,
  proof: { some: 'proof' },
  chunkLens: null,
  trustedRoot,
  storeId: 'store-1',
  resourceKey: 'index.html',
  salt: null,
});

describe('verifyAndDecrypt — fail-closed on a resolved trusted root (#2276)', () => {
  it('REFUSES (throws, returns no bytes) when a trusted root is resolved but the proof does not verify — even though decrypt succeeds', () => {
    const dig = makeDig({ inclusionVerifies: false }); // proof fails, but bytes WOULD decrypt cleanly
    expect(() => verifyAndDecrypt(baseReq(dig, TRUSTED_ROOT))).toThrow(/inclusion proof failed/i);
    // The load-bearing assertion: attacker bytes were never even decrypted (gate precedes decrypt).
    expect(dig.decryptChunk).not.toHaveBeenCalled();
  });

  it('also refuses when verifyInclusion itself throws on the served proof (treated as unverified)', () => {
    const dig = makeDig({ inclusionVerifies: true, verifyThrows: true });
    expect(() => verifyAndDecrypt(baseReq(dig, TRUSTED_ROOT))).toThrow(/inclusion proof failed/i);
    expect(dig.decryptChunk).not.toHaveBeenCalled();
  });

  it('returns bytes with verified:true on the happy path (resolved trusted root + proof verifies)', () => {
    const dig = makeDig({ inclusionVerifies: true });
    const { bytes, verified } = verifyAndDecrypt(baseReq(dig, TRUSTED_ROOT));
    expect(verified).toBe(true);
    expect(bytes).toEqual(PLAINTEXT);
  });

  it('BLIND path: a null trusted root (unresolvable chain anchor) still serves the SAME bytes, advisory (NOT gated)', () => {
    const dig = makeDig({ inclusionVerifies: false }); // no trusted root ⇒ verdict is moot
    const { bytes, verified } = verifyAndDecrypt(baseReq(dig, null));
    expect(verified).toBe(false); // reported unverified (badge shows unverified)
    expect(bytes).toEqual(PLAINTEXT); // but content still loads — the legitimate oblivious path
    // The proof is not even consulted when there is no trusted root to fold to.
    expect(dig.verifyInclusion).not.toHaveBeenCalled();
  });

  it('a decrypt/tag failure still throws (unchanged) — verified path but corrupt bytes', () => {
    const dig = makeDig({ inclusionVerifies: true, decryptThrows: true });
    expect(() => verifyAndDecrypt(baseReq(dig, TRUSTED_ROOT))).toThrow(/decrypt failed/i);
  });
});

describe('decryptChunks — multi-chunk reassembly (unchanged behaviour)', () => {
  it('reassembles multiple chunks in order using per-chunk ciphertext lengths', () => {
    const ct = new Uint8Array([10, 11, 20, 21, 22]);
    const dig: ContentCrypto = {
      verifyInclusion: vi.fn(() => true),
      deriveKey: vi.fn(() => 'k'),
      // Echo the chunk back so we can assert boundaries: chunk lens [2,3] → [10,11] then [20,21,22].
      decryptChunk: vi.fn((_k: string, c: Uint8Array) => c),
    };
    const out = decryptChunks(dig, 'k', ct, [2, 3]);
    expect(Array.from(out)).toEqual([10, 11, 20, 21, 22]);
    expect(dig.decryptChunk).toHaveBeenCalledTimes(2);
  });

  it('throws when the summed chunk lengths do not match the ciphertext length', () => {
    const dig: ContentCrypto = {
      verifyInclusion: vi.fn(() => true),
      deriveKey: vi.fn(() => 'k'),
      decryptChunk: vi.fn((_k: string, c: Uint8Array) => c),
    };
    expect(() => decryptChunks(dig, 'k', new Uint8Array([1, 2, 3]), [2, 2])).toThrow(/chunk lengths/i);
  });
});
