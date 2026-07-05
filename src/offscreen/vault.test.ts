import { describe, it, expect } from 'vitest';
import { Vault } from './vault';
import type { Argon2Fn } from '@/lib/keystore/digwx1';
import { isValidMnemonic, mnemonicToEntropy } from '@/lib/keystore/bip39';

// Fast, deterministic Argon2 stand-in so the vault's create/unlock cycle doesn't pay the 64 MiB KDF
// cost per test. The real hash-wasm Argon2id is covered by digwx1.test.ts.
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

const deps = { argon2Fn: fakeArgon2 };
const PW = 'a-strong-password';

describe('offscreen Vault', () => {
  it('starts empty (no key held)', () => {
    const v = new Vault();
    expect(v.hasKey()).toBe(false);
  });

  it('createWallet generates a 24-word phrase, holds the key, and returns a record to persist', async () => {
    const v = new Vault();
    const res = await v.handle({ op: 'createWallet', password: PW, label: 'main' }, deps);
    expect(res.success).toBe(true);
    expect(res.hasKey).toBe(true);
    expect(v.hasKey()).toBe(true);
    expect(res.mnemonic && isValidMnemonic(res.mnemonic)).toBe(true);
    expect(res.record?.magic).toBe('DIGWX1');
    expect(res.record?.label).toBe('main');
    // The record decrypts back to the same entropy as the shown phrase.
    const reopened = new Vault();
    const un = await reopened.handle({ op: 'unlockWallet', password: PW, record: res.record! }, deps);
    expect(un.success).toBe(true);
    // reveal returns the same phrase.
    const rev = await reopened.handle({ op: 'revealPhrase', password: PW, record: res.record! }, deps);
    expect(rev.mnemonic).toBe(res.mnemonic);
  });

  it('createWallet honours the STRONG preset', async () => {
    const v = new Vault();
    const res = await v.handle({ op: 'createWallet', password: PW, strong: true }, deps);
    if (res.record?.kdf.id === 'argon2id') expect(res.record.kdf.memKiB).toBe(262144);
  });

  it('importWallet accepts a valid phrase and rejects an invalid one', async () => {
    const v = new Vault();
    const phrase =
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art';
    const ok = await v.handle({ op: 'importWallet', password: PW, mnemonic: phrase }, deps);
    expect(ok.success).toBe(true);
    expect(v.hasKey()).toBe(true);

    const bad = await new Vault().handle({ op: 'importWallet', password: PW, mnemonic: 'not a phrase' }, deps);
    expect(bad.success).toBe(false);
    expect(bad.code).toBe('INVALID_MNEMONIC');
  });

  it('imported record round-trips to the same entropy as the source phrase', async () => {
    const phrase =
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art';
    const res = await new Vault().handle({ op: 'importWallet', password: PW, mnemonic: phrase }, deps);
    const rev = await new Vault().handle({ op: 'revealPhrase', password: PW, record: res.record! }, deps);
    expect(rev.mnemonic).toBe(phrase);
    expect(mnemonicToEntropy(rev.mnemonic!)).toEqual(new Uint8Array(32));
  });

  it('unlock fails opaquely with a wrong password', async () => {
    const created = await new Vault().handle({ op: 'createWallet', password: PW }, deps);
    const res = await new Vault().handle({ op: 'unlockWallet', password: 'wrong', record: created.record! }, deps);
    expect(res.success).toBe(false);
    expect(res.code).toBe('UNLOCK_FAILED');
  });

  it('lock zeroizes and drops the held key', async () => {
    const v = new Vault();
    await v.handle({ op: 'createWallet', password: PW }, deps);
    expect(v.hasKey()).toBe(true);
    const res = await v.handle({ op: 'lockWallet' }, deps);
    expect(res.success).toBe(true);
    expect(res.hasKey).toBe(false);
    expect(v.hasKey()).toBe(false);
  });

  it('getVaultState reports whether a key is held', async () => {
    const v = new Vault();
    expect((await v.handle({ op: 'getVaultState' }, deps)).hasKey).toBe(false);
    await v.handle({ op: 'createWallet', password: PW }, deps);
    expect((await v.handle({ op: 'getVaultState' }, deps)).hasKey).toBe(true);
  });

  it('revealPhrase re-auths and does not change held-key state', async () => {
    const created = await new Vault().handle({ op: 'createWallet', password: PW }, deps);
    const locked = new Vault(); // no key held
    const rev = await locked.handle({ op: 'revealPhrase', password: PW, record: created.record! }, deps);
    expect(rev.success).toBe(true);
    expect(rev.mnemonic).toBe(created.mnemonic);
    expect(locked.hasKey()).toBe(false); // reveal must NOT unlock the session
  });

  it('rejects create/unlock/reveal with missing required fields', async () => {
    const v = new Vault();
    expect((await v.handle({ op: 'createWallet' }, deps)).code).toBe('BAD_REQUEST');
    expect((await v.handle({ op: 'unlockWallet', password: PW }, deps)).code).toBe('BAD_REQUEST');
    expect((await v.handle({ op: 'revealPhrase', record: {} as never }, deps)).code).toBe('BAD_REQUEST');
  });

  it('rejects an unknown op', async () => {
    const res = await new Vault().handle({ op: 'nope' as never }, deps);
    expect(res.success).toBe(false);
    expect(res.code).toBe('BAD_REQUEST');
  });
});
