import { describe, it, expect } from 'vitest';
import {
  encryptEntropy,
  decryptEntropy,
  canonicalHeader,
  needsUpgrade,
  isValidDigwx1Record,
  KeystoreError,
  MAGIC,
  VERSION,
  ARGON2_DEFAULT,
  ARGON2_STRONG,
  PBKDF2_ITERS,
  type Digwx1Record,
  type Argon2Fn,
} from './digwx1';

const PASSWORD = 'correct horse battery staple';
const ENTROPY = new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff);

// A fast Argon2 stand-in so tests don't pay the 64 MiB KDF cost for every case. It is deterministic
// over (password, salt) and 32 bytes wide — enough to exercise the AEAD + record paths. The REAL
// hash-wasm argon2id is exercised by the default-path test below.
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

describe('DIGWX1 keystore', () => {
  it('round-trips entropy with the real Argon2id default params', async () => {
    const { record, usedFallback } = await encryptEntropy(ENTROPY, PASSWORD);
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
    const { record } = await encryptEntropy(ENTROPY, PASSWORD, { argon2Fn: fakeArgon2, argon2Params: ARGON2_STRONG });
    if (record.kdf.id === 'argon2id') expect(record.kdf.memKiB).toBe(ARGON2_STRONG.memKiB);
    expect(await decryptEntropy(record, PASSWORD, fakeArgon2)).toEqual(ENTROPY);
  });

  it('uses fresh salt + nonce on every encryption (no reuse)', async () => {
    const a = await encryptEntropy(ENTROPY, PASSWORD, { argon2Fn: fakeArgon2 });
    const b = await encryptEntropy(ENTROPY, PASSWORD, { argon2Fn: fakeArgon2 });
    expect(a.record.kdf.salt).not.toBe(b.record.kdf.salt);
    expect(a.record.cipher.nonce).not.toBe(b.record.cipher.nonce);
    expect(a.record.ciphertext).not.toBe(b.record.ciphertext);
  });

  it('fails opaquely on a wrong password', async () => {
    const { record } = await encryptEntropy(ENTROPY, PASSWORD, { argon2Fn: fakeArgon2 });
    await expect(decryptEntropy(record, 'wrong', fakeArgon2)).rejects.toMatchObject({
      code: 'UNLOCK_FAILED',
    });
  });

  it('fails closed when the header AAD is tampered (salt/nonce/params bound)', async () => {
    const { record } = await encryptEntropy(ENTROPY, PASSWORD, { argon2Fn: fakeArgon2 });

    const tamperedNonce: Digwx1Record = { ...record, cipher: { ...record.cipher, nonce: btoa('0'.repeat(12)) } };
    await expect(decryptEntropy(tamperedNonce, PASSWORD, fakeArgon2)).rejects.toBeInstanceOf(KeystoreError);

    const tamperedSalt: Digwx1Record = { ...record, kdf: { ...record.kdf, salt: btoa('0'.repeat(16)) } };
    await expect(decryptEntropy(tamperedSalt, PASSWORD, fakeArgon2)).rejects.toMatchObject({ code: 'UNLOCK_FAILED' });
  });

  it('fails on a tampered ciphertext', async () => {
    const { record } = await encryptEntropy(ENTROPY, PASSWORD, { argon2Fn: fakeArgon2 });
    const flipped = record.ciphertext.slice(0, -2) + (record.ciphertext.endsWith('A') ? 'B' : 'A') + '=';
    await expect(decryptEntropy({ ...record, ciphertext: flipped }, PASSWORD, fakeArgon2)).rejects.toBeInstanceOf(
      KeystoreError,
    );
  });

  it('rejects a structurally-invalid record with BAD_RECORD', async () => {
    const bogus = { magic: 'NOPE', version: 1 } as unknown as Digwx1Record;
    await expect(decryptEntropy(bogus, PASSWORD, fakeArgon2)).rejects.toMatchObject({ code: 'BAD_RECORD' });
  });

  it('binds the full header into the AAD (canonical, field-ordered)', async () => {
    const { record } = await encryptEntropy(ENTROPY, PASSWORD, { argon2Fn: fakeArgon2, label: 'main' });
    const header = JSON.parse(new TextDecoder().decode(canonicalHeader(record)));
    expect(header).toMatchObject({ version: VERSION, magic: MAGIC, cipher: { id: 'aes-256-gcm' } });
    expect(header.kdf.id).toBe('argon2id');
    expect(record.label).toBe('main');
  });

  it('falls back to PBKDF2 when Argon2 is unavailable, flagging re-encryption', async () => {
    const failing: Argon2Fn = (async () => {
      throw new Error('wasm failed to instantiate');
    }) as unknown as Argon2Fn;
    const { record, usedFallback } = await encryptEntropy(ENTROPY, PASSWORD, { argon2Fn: failing });
    expect(usedFallback).toBe(true);
    expect(record.kdf.id).toBe('pbkdf2');
    if (record.kdf.id === 'pbkdf2') expect(record.kdf.iters).toBe(PBKDF2_ITERS);
    expect(needsUpgrade(record)).toBe(true);
    // A PBKDF2 record decrypts without needing Argon2 at all (default argon2Fn arg is unused here).
    expect(await decryptEntropy(record, PASSWORD)).toEqual(ENTROPY);
  });

  it('reports argon2 records as not needing upgrade', async () => {
    const { record } = await encryptEntropy(ENTROPY, PASSWORD, { argon2Fn: fakeArgon2 });
    expect(needsUpgrade(record)).toBe(false);
  });

  // #115 — the structural validator backup/restore reuses to accept-or-reject a file's embedded
  // record BEFORE ever attempting to decrypt it (a wrong file must never reach the crypto layer).
  describe('isValidDigwx1Record (#115 keystore backup validation)', () => {
    it('accepts a real record produced by encryptEntropy', async () => {
      const { record } = await encryptEntropy(ENTROPY, PASSWORD, { argon2Fn: fakeArgon2 });
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
  });
});
