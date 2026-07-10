import { describe, it, expect } from 'vitest';
import {
  encryptEntropy,
  encryptEntropyLegacyV1,
  decryptEntropy,
  canonicalHeader,
  needsUpgrade,
  isValidDigwx1Record,
  KeystoreError,
  MAGIC,
  VERSION,
  VERSION_V2,
  ARGON2_DEFAULT,
  ARGON2_STRONG,
  PBKDF2_ITERS,
  type Digwx1Record,
  type Digwx1RecordV1,
  type Argon2Fn,
} from './digwx1';
import { makeFakeKeystoreWasm } from '@/test/keystoreWasmFake';

const PASSWORD = 'correct horse battery staple';
const ENTROPY = new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff);

// A fast Argon2 stand-in so tests don't pay the 64 MiB KDF cost for every legacy-V1 case. It is
// deterministic over (password, salt) and 32 bytes wide — enough to exercise the AEAD + record
// paths. The REAL hash-wasm argon2id is exercised by the default-path test below.
const fakeArgon2: Argon2Fn = (async (opts: {
  password: string | Uint8Array;
  salt: Uint8Array;
  hashLength: number;
}) => {
  const pw = typeof opts.password === 'string' ? new TextEncoder().encode(opts.password) : opts.password;
  const out = new Uint8Array(opts.hashLength);
  for (let i = 0; i < out.length; i++) out[i] = (pw[i % pw.length] ^ opts.salt[i % opts.salt.length] ^ i) & 0xff;
  return out;
}) as unknown as Argon2Fn;

describe('DIGWX1 keystore — V2 (dig-keystore-wasm-backed production writer, #147 Phase B)', () => {
  it('round-trips entropy through the injected dig-keystore-wasm surface', async () => {
    const keystoreWasm = makeFakeKeystoreWasm();
    const { record, usedFallback } = await encryptEntropy(ENTROPY, PASSWORD, { keystoreWasm });
    expect(usedFallback).toBe(false);
    expect(record.magic).toBe(MAGIC);
    expect(record.version).toBe(VERSION_V2);
    expect(record.kdf.id).toBe('dig-keystore-opaque');
    expect(record.cipher.id).toBe('dig-keystore-opaque');
    const out = await decryptEntropy(record, PASSWORD, { keystoreWasm });
    expect(out).toEqual(ENTROPY);
  });

  it('calls sealStrong (not seal) when strong is requested', async () => {
    const keystoreWasm = makeFakeKeystoreWasm();
    const { record } = await encryptEntropy(ENTROPY, PASSWORD, { keystoreWasm, strong: true });
    // The fake's sealStrong tags the blob with 'S' as its first byte (base64-decoded).
    const raw = Uint8Array.from(atob(record.ciphertext), (c) => c.charCodeAt(0));
    expect(String.fromCharCode(raw[0])).toBe('S');
    expect(await decryptEntropy(record, PASSWORD, { keystoreWasm })).toEqual(ENTROPY);
  });

  it('stores an optional label', async () => {
    const keystoreWasm = makeFakeKeystoreWasm();
    const { record } = await encryptEntropy(ENTROPY, PASSWORD, { keystoreWasm, label: 'main' });
    expect(record.label).toBe('main');
  });

  it('fails opaquely on a wrong password', async () => {
    const keystoreWasm = makeFakeKeystoreWasm();
    const { record } = await encryptEntropy(ENTROPY, PASSWORD, { keystoreWasm });
    await expect(decryptEntropy(record, 'wrong', { keystoreWasm })).rejects.toMatchObject({ code: 'UNLOCK_FAILED' });
  });

  it('throws KDF_UNAVAILABLE opening a V2 record without a keystoreWasm', async () => {
    const keystoreWasm = makeFakeKeystoreWasm();
    const { record } = await encryptEntropy(ENTROPY, PASSWORD, { keystoreWasm });
    await expect(decryptEntropy(record, PASSWORD)).rejects.toMatchObject({ code: 'KDF_UNAVAILABLE' });
  });

  it('is never flagged as needing an upgrade (it IS the current format)', async () => {
    const keystoreWasm = makeFakeKeystoreWasm();
    const { record } = await encryptEntropy(ENTROPY, PASSWORD, { keystoreWasm });
    expect(needsUpgrade(record)).toBe(false);
  });

  it('validates as a well-formed DIGWX1 record', async () => {
    const keystoreWasm = makeFakeKeystoreWasm();
    const { record } = await encryptEntropy(ENTROPY, PASSWORD, { keystoreWasm });
    expect(isValidDigwx1Record(record)).toBe(true);
  });
});

describe('DIGWX1 keystore — V1 (legacy, decode-only) backwards compatibility (#147 Phase B)', () => {
  it('round-trips entropy with the real Argon2id default params (encryptEntropyLegacyV1)', async () => {
    const { record, usedFallback } = await encryptEntropyLegacyV1(ENTROPY, PASSWORD);
    expect(usedFallback).toBe(false);
    expect(record.magic).toBe(MAGIC);
    expect(record.version).toBe(VERSION);
    expect(record.kdf.id).toBe('argon2id');
    if (record.kdf.id === 'argon2id') {
      expect(record.kdf.memKiB).toBe(ARGON2_DEFAULT.memKiB);
      expect(record.kdf.iters).toBe(ARGON2_DEFAULT.iters);
      expect(record.kdf.lanes).toBe(ARGON2_DEFAULT.lanes);
    }
    const out = await decryptEntropy(record, PASSWORD);
    expect(out).toEqual(ENTROPY);
  }, 20_000);

  it('accepts a STRONG preset and stores its params', async () => {
    const { record } = await encryptEntropyLegacyV1(ENTROPY, PASSWORD, { argon2Fn: fakeArgon2, argon2Params: ARGON2_STRONG });
    if (record.kdf.id === 'argon2id') expect(record.kdf.memKiB).toBe(ARGON2_STRONG.memKiB);
    expect(await decryptEntropy(record, PASSWORD, { argon2Fn: fakeArgon2 })).toEqual(ENTROPY);
  });

  it('uses fresh salt + nonce on every encryption (no reuse)', async () => {
    const a = await encryptEntropyLegacyV1(ENTROPY, PASSWORD, { argon2Fn: fakeArgon2 });
    const b = await encryptEntropyLegacyV1(ENTROPY, PASSWORD, { argon2Fn: fakeArgon2 });
    expect(a.record.kdf.salt).not.toBe(b.record.kdf.salt);
    expect(a.record.cipher.nonce).not.toBe(b.record.cipher.nonce);
    expect(a.record.ciphertext).not.toBe(b.record.ciphertext);
  });

  it('fails opaquely on a wrong password', async () => {
    const { record } = await encryptEntropyLegacyV1(ENTROPY, PASSWORD, { argon2Fn: fakeArgon2 });
    await expect(decryptEntropy(record, 'wrong', { argon2Fn: fakeArgon2 })).rejects.toMatchObject({
      code: 'UNLOCK_FAILED',
    });
  });

  it('fails closed when the header AAD is tampered (salt/nonce/params bound)', async () => {
    const { record } = await encryptEntropyLegacyV1(ENTROPY, PASSWORD, { argon2Fn: fakeArgon2 });

    const tamperedNonce: Digwx1Record = { ...record, cipher: { ...record.cipher, nonce: btoa('0'.repeat(12)) } };
    await expect(decryptEntropy(tamperedNonce, PASSWORD, { argon2Fn: fakeArgon2 })).rejects.toBeInstanceOf(KeystoreError);

    const tamperedSalt: Digwx1Record = { ...record, kdf: { ...record.kdf, salt: btoa('0'.repeat(16)) } };
    await expect(decryptEntropy(tamperedSalt, PASSWORD, { argon2Fn: fakeArgon2 })).rejects.toMatchObject({ code: 'UNLOCK_FAILED' });
  });

  it('fails on a tampered ciphertext', async () => {
    const { record } = await encryptEntropyLegacyV1(ENTROPY, PASSWORD, { argon2Fn: fakeArgon2 });
    const flipped = record.ciphertext.slice(0, -2) + (record.ciphertext.endsWith('A') ? 'B' : 'A') + '=';
    await expect(
      decryptEntropy({ ...record, ciphertext: flipped }, PASSWORD, { argon2Fn: fakeArgon2 }),
    ).rejects.toBeInstanceOf(KeystoreError);
  });

  it('rejects a structurally-invalid record with BAD_RECORD', async () => {
    const bogus = { magic: 'NOPE', version: 1 } as unknown as Digwx1Record;
    await expect(decryptEntropy(bogus, PASSWORD, { argon2Fn: fakeArgon2 })).rejects.toMatchObject({ code: 'BAD_RECORD' });
  });

  it('binds the full header into the AAD (canonical, field-ordered)', async () => {
    const { record } = await encryptEntropyLegacyV1(ENTROPY, PASSWORD, { argon2Fn: fakeArgon2, label: 'main' });
    const header = JSON.parse(new TextDecoder().decode(canonicalHeader(record as Digwx1RecordV1)));
    expect(header).toMatchObject({ version: VERSION, magic: MAGIC, cipher: { id: 'aes-256-gcm' } });
    expect(header.kdf.id).toBe('argon2id');
    expect(record.label).toBe('main');
  });

  it('falls back to PBKDF2 when Argon2 is unavailable, flagging re-encryption', async () => {
    const failing: Argon2Fn = (async () => {
      throw new Error('wasm failed to instantiate');
    }) as unknown as Argon2Fn;
    const { record, usedFallback } = await encryptEntropyLegacyV1(ENTROPY, PASSWORD, { argon2Fn: failing });
    expect(usedFallback).toBe(true);
    expect(record.kdf.id).toBe('pbkdf2');
    if (record.kdf.id === 'pbkdf2') expect(record.kdf.iters).toBe(PBKDF2_ITERS);
    expect(needsUpgrade(record)).toBe(true);
    // A PBKDF2 record decrypts without needing Argon2 at all (default argon2Fn arg is unused here).
    expect(await decryptEntropy(record, PASSWORD)).toEqual(ENTROPY);
  });

  it('reports argon2 V1 records as needing upgrade (any V1 record is legacy relative to V2)', async () => {
    const { record } = await encryptEntropyLegacyV1(ENTROPY, PASSWORD, { argon2Fn: fakeArgon2 });
    expect(needsUpgrade(record)).toBe(true);
  });

  // #115 — the structural validator backup/restore reuses to accept-or-reject a file's embedded
  // record BEFORE ever attempting to decrypt it (a wrong file must never reach the crypto layer).
  describe('isValidDigwx1Record (#115 keystore backup validation)', () => {
    it('accepts a real record produced by encryptEntropyLegacyV1', async () => {
      const { record } = await encryptEntropyLegacyV1(ENTROPY, PASSWORD, { argon2Fn: fakeArgon2 });
      expect(isValidDigwx1Record(record)).toBe(true);
    });

    it('rejects null/undefined/non-object input', () => {
      expect(isValidDigwx1Record(null)).toBe(false);
      expect(isValidDigwx1Record(undefined)).toBe(false);
      expect(isValidDigwx1Record('not an object')).toBe(false);
      expect(isValidDigwx1Record(42)).toBe(false);
    });

    it('rejects a record with the wrong magic/version', () => {
      expect(isValidDigwx1Record({ magic: 'NOPE', version: 1, kdf: {}, cipher: { id: 'aes-256-gcm' }, ciphertext: 'x' })).toBe(false);
      expect(isValidDigwx1Record({ magic: MAGIC, version: 99, kdf: {}, cipher: { id: 'aes-256-gcm' }, ciphertext: 'x' })).toBe(false);
    });

    it('rejects a record missing kdf/cipher/ciphertext', () => {
      expect(isValidDigwx1Record({ magic: MAGIC, version: VERSION })).toBe(false);
      expect(isValidDigwx1Record({ magic: MAGIC, version: VERSION, kdf: {}, cipher: { id: 'aes-256-gcm' } })).toBe(false);
    });

    it('rejects a V1-shaped record claiming the V2 cipher id, and vice versa', () => {
      expect(
        isValidDigwx1Record({ magic: MAGIC, version: VERSION, kdf: {}, cipher: { id: 'dig-keystore-opaque' }, ciphertext: 'x' }),
      ).toBe(false);
      expect(
        isValidDigwx1Record({ magic: MAGIC, version: VERSION_V2, kdf: {}, cipher: { id: 'aes-256-gcm' }, ciphertext: 'x' }),
      ).toBe(false);
    });
  });
});

describe('DIGWX1 keystore — golden-fixture old-blob decrypt proof (#147 Phase B, HARD requirement)', () => {
  // A REAL V1 record captured once from `encryptEntropyLegacyV1` (the extension's original
  // hand-rolled Argon2id/AES-GCM writer, before this migration), pinned verbatim — representing an
  // ACTUAL existing user's vault blob written by a pre-migration build of this extension. This is
  // deliberately a literal fixture (not re-generated by the current code in the same test run) so
  // a future regression in the V1 decode path — or an accidental deletion of that path entirely —
  // fails this test, instead of two drifted implementations silently agreeing with each other.
  //
  // Regeneration (only if this fixture ever needs replacing): call `encryptEntropyLegacyV1(entropy,
  // password)` once, with hash-wasm's real argon2id (no argon2Fn override), and paste the resulting
  // record + entropy hex below.
  const GOLDEN_PASSWORD = 'a-real-users-existing-vault-password';
  const GOLDEN_ENTROPY_HEX = '05101b26313c47525d68737e89949faab5c0cbd6e1ecf7020d18232e39444f5a';
  const GOLDEN_V1_RECORD: Digwx1Record = {
    version: 1,
    magic: 'DIGWX1',
    kdf: { id: 'argon2id', memKiB: 65536, iters: 3, lanes: 4, salt: '3Tkv+8vaNAdt64W5yHhwIg==' },
    cipher: { id: 'aes-256-gcm', nonce: 'NDvY5dze3ySpsNd1' },
    ciphertext: 'XH+HHlgWTmzErGUFQZ0O/Ss7kZQNGHx4kVyiSCk9NbBHPMOhodXP3/dOV4HrOFff',
    createdAt: 1783650852744,
  };

  it('an existing user\'s pre-migration V1 vault still decrypts to the exact original entropy', async () => {
    const entropy = await decryptEntropy(GOLDEN_V1_RECORD, GOLDEN_PASSWORD);
    const hex = Array.from(entropy)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    expect(hex).toBe(GOLDEN_ENTROPY_HEX);
  }, 20_000);

  it('the golden fixture is structurally recognized as a valid (legacy) DIGWX1 record', () => {
    expect(isValidDigwx1Record(GOLDEN_V1_RECORD)).toBe(true);
    expect(needsUpgrade(GOLDEN_V1_RECORD)).toBe(true);
  });

  it('the golden fixture rejects the wrong password (still fails closed post-migration)', async () => {
    await expect(decryptEntropy(GOLDEN_V1_RECORD, 'not-the-password')).rejects.toMatchObject({
      code: 'UNLOCK_FAILED',
    });
  }, 20_000);
});
