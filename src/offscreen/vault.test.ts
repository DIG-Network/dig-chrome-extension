import { describe, it, expect, beforeAll } from 'vitest';
import { Vault } from './vault';
import type { Argon2Fn } from '@/lib/keystore/digwx1';
import { encryptEntropyLegacyV1 } from '@/lib/keystore/digwx1';
import { isValidMnemonic, mnemonicToEntropy } from '@/lib/keystore/bip39';
import { mnemonicToSeed } from '@/lib/keystore/bip39';
import { loadChiaWasmNode } from '@/test/chiaWasm';
import type { ScanWasm } from '@/offscreen/scan';
import type { ChainClient } from '@/offscreen/chain';
import { signDappCoinSpends, type WireCoinSpend } from '@/offscreen/dappSign';
import { buildKeyring, prepareXchSend, signAndBundle, type SendFlowWasm } from '@/offscreen/sendFlow';
import { TESTNET11_AGG_SIG_ME } from '@/offscreen/signing';
import { prepareClawbackAction, type ClawbackInfo, type ClawbackWasm } from '@/offscreen/clawback';
import { masterFromSeed, deriveWalletSecretKeyHex } from '@/lib/keystore/derive';
import golden from '@/lib/keystore/derive.golden.json';
import { makeFakeKeystoreWasm } from '@/test/keystoreWasmFake';

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

// dig_ecosystem #147 Phase B: createWallet/importWallet (V2 writer) and unlock/reveal/export (V2
// reader) all need `keystoreWasm` — see `@/test/keystoreWasmFake`'s module doc for why a fake
// stands in here instead of the real `@dignetwork/dig-keystore-wasm`.
const deps = { argon2Fn: fakeArgon2, keystoreWasm: makeFakeKeystoreWasm() };
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

  it('createWallet honours the STRONG preset (dig_ecosystem #147 Phase B — calls sealStrong, not seal)', async () => {
    const v = new Vault();
    const res = await v.handle({ op: 'createWallet', password: PW, strong: true }, deps);
    expect(res.record?.version).toBe(2);
    // The fake keystoreWasm tags a sealStrong-produced blob with 'S' as its first byte.
    const raw = Uint8Array.from(atob(res.record!.ciphertext), (c) => c.charCodeAt(0));
    expect(String.fromCharCode(raw[0])).toBe('S');
    // ... and the DEFAULT (non-strong) path tags with 'D'.
    const def = await new Vault().handle({ op: 'createWallet', password: PW }, deps);
    const defRaw = Uint8Array.from(atob(def.record!.ciphertext), (c) => c.charCodeAt(0));
    expect(String.fromCharCode(defRaw[0])).toBe('D');
  });

  describe('dig_ecosystem #147 Phase B — keystoreWasm wiring', () => {
    it('createWallet/importWallet report WASM_UNAVAILABLE without keystoreWasm', async () => {
      const noWasm = { argon2Fn: fakeArgon2 };
      const created = await new Vault().handle({ op: 'createWallet', password: PW }, noWasm);
      expect(created).toMatchObject({ success: false, code: 'WASM_UNAVAILABLE' });
      const imported = await new Vault().handle(
        { op: 'importWallet', password: PW, mnemonic: 'abandon '.repeat(23) + 'art' },
        noWasm,
      );
      expect(imported).toMatchObject({ success: false, code: 'WASM_UNAVAILABLE' });
    });

    it('unlockWallet opens an EXISTING (pre-migration) V1 legacy record with no keystoreWasm at all', async () => {
      // A real V1 record (the extension's original writer) — representing an existing user's
      // vault created before this extension migrated to the V2 (dig-keystore-wasm-backed) writer.
      const entropy = mnemonicToEntropy('abandon '.repeat(23) + 'art');
      const { record: legacyRecord } = await encryptEntropyLegacyV1(entropy, PW, { argon2Fn: fakeArgon2 });
      expect(legacyRecord.version).toBe(1);

      // Unlocks fine with ONLY argon2Fn in deps — keystoreWasm is irrelevant to the V1 decode path.
      const res = await new Vault().handle(
        { op: 'unlockWallet', password: PW, record: legacyRecord },
        { argon2Fn: fakeArgon2 },
      );
      expect(res).toMatchObject({ success: true, hasKey: true });
    });
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

describe('offscreen Vault multi-wallet (#90)', () => {
  let chia: ScanWasm;
  beforeAll(async () => {
    chia = (await loadChiaWasmNode()) as ScanWasm;
  });

  it('holds several wallets at once and switches the active one instantly (no re-unlock)', async () => {
    const v = new Vault();
    expect((await v.handle({ op: 'createWallet', walletId: 'A', password: PW }, deps)).success).toBe(true);
    expect((await v.handle({ op: 'createWallet', walletId: 'B', password: PW }, deps)).success).toBe(true);
    // B is active (last held); switching back to A is instant, no password.
    expect(v.hasKey()).toBe(true);
    const sw = await v.handle({ op: 'switchWallet', walletId: 'A' }, deps);
    expect(sw.success).toBe(true);
    expect(sw.hasKey).toBe(true);
  });

  it('the ACTIVE wallet drives the derived receive address (switching re-derives)', async () => {
    const v = new Vault();
    await v.handle({ op: 'importWallet', walletId: 'A', password: PW, mnemonic: golden.mnemonic }, deps);
    await v.handle({ op: 'createWallet', walletId: 'B', password: PW }, deps); // fresh random → now active
    const addrB = await v.handle({ op: 'getReceiveAddress' }, { ...deps, chia });
    await v.handle({ op: 'switchWallet', walletId: 'A' }, deps);
    const addrA = await v.handle({ op: 'getReceiveAddress' }, { ...deps, chia });
    expect(addrA.address).toBe(golden.unhardened[0].address);
    expect(addrA.address).not.toBe(addrB.address); // switching genuinely re-derives the active wallet
  });

  it('switchWallet to a wallet not unlocked this session returns NEEDS_UNLOCK', async () => {
    const v = new Vault();
    await v.handle({ op: 'createWallet', walletId: 'A', password: PW }, deps);
    const res = await v.handle({ op: 'switchWallet', walletId: 'ghost' }, deps);
    expect(res.success).toBe(false);
    expect(res.code).toBe('NEEDS_UNLOCK');
  });

  it('switchWallet without a walletId is BAD_REQUEST', async () => {
    expect((await new Vault().handle({ op: 'switchWallet' }, deps)).code).toBe('BAD_REQUEST');
  });

  it('forgetWallet drops one wallet key; forgetting the active one locks the session', async () => {
    const v = new Vault();
    await v.handle({ op: 'createWallet', walletId: 'A', password: PW }, deps);
    await v.handle({ op: 'createWallet', walletId: 'B', password: PW }, deps); // B active
    // Forget the NON-active A → B stays active + unlocked, but A can no longer be switched to.
    expect((await v.handle({ op: 'forgetWallet', walletId: 'A' }, deps)).success).toBe(true);
    expect(v.hasKey()).toBe(true);
    expect((await v.handle({ op: 'switchWallet', walletId: 'A' }, deps)).code).toBe('NEEDS_UNLOCK');
    // Forget the ACTIVE B → nothing held.
    const f2 = await v.handle({ op: 'forgetWallet', walletId: 'B' }, deps);
    expect(f2.hasKey).toBe(false);
    expect(v.hasKey()).toBe(false);
  });

  it('lock zeroizes EVERY held wallet key', async () => {
    const v = new Vault();
    await v.handle({ op: 'createWallet', walletId: 'A', password: PW }, deps);
    await v.handle({ op: 'createWallet', walletId: 'B', password: PW }, deps);
    v.lock();
    expect(v.hasKey()).toBe(false);
    expect((await v.handle({ op: 'switchWallet', walletId: 'A' }, deps)).code).toBe('NEEDS_UNLOCK');
    expect((await v.handle({ op: 'switchWallet', walletId: 'B' }, deps)).code).toBe('NEEDS_UNLOCK');
  });
});

describe('Vault dApp RPC ops (#56 §5.5)', () => {
  let chia: ScanWasm;
  beforeAll(async () => {
    chia = (await loadChiaWasmNode()) as ScanWasm;
  });

  async function goldenWallet(): Promise<Vault> {
    const v = new Vault();
    await v.handle({ op: 'importWallet', password: PW, mnemonic: golden.mnemonic }, deps);
    return v;
  }

  interface SpendWasm {
    Simulator: new () => { newCoin(ph: Uint8Array, a: bigint): unknown; bls(a: bigint): { sk: unknown; pk: { toBytes(): Uint8Array }; puzzleHash: Uint8Array; coin: unknown } };
    SecretKey: { fromSeed(seed: Uint8Array): { deriveUnhardenedPath(p: number[]): { deriveSynthetic(): { publicKey(): { toBytes(): Uint8Array } } } } };
    Clvm: new () => {
      delegatedSpend(c: unknown[]): unknown;
      createCoin(ph: Uint8Array, a: bigint, m: undefined): unknown;
      spendStandardCoin(coin: unknown, pk: unknown, spend: unknown): void;
      coinSpends(): Array<{ coin: { parentCoinInfo: Uint8Array; puzzleHash: Uint8Array; amount: bigint }; puzzleReveal: Uint8Array; solution: Uint8Array }>;
    };
    fromHex(h: string): Uint8Array;
    toHex(b: Uint8Array): string;
  }

  type CoinSpendLike = { coin: { parentCoinInfo: Uint8Array; puzzleHash: Uint8Array; amount: bigint }; puzzleReveal: Uint8Array; solution: Uint8Array };

  /** Serialize a wasm coin spend to the dApp wire shape (hex fields), as a page would supply it. */
  function toWire(w: SpendWasm, coinSpends: CoinSpendLike[]): WireCoinSpend[] {
    return coinSpends.map((cs) => ({
      coin: {
        parent_coin_info: w.toHex(cs.coin.parentCoinInfo),
        puzzle_hash: w.toHex(cs.coin.puzzleHash),
        amount: cs.coin.amount.toString(),
      },
      puzzle_reveal: w.toHex(cs.puzzleReveal),
      solution: w.toHex(cs.solution),
    }));
  }

  /** Build a standard self-send coin spend the golden wallet OWNS (index-0 unhardened) → wire. */
  function goldenOwnedWire(): WireCoinSpend[] {
    const w = chia as unknown as SpendWasm;
    const ph0 = golden.unhardened[0].puzzleHashHex;
    const synthPk = w.SecretKey.fromSeed(w.fromHex(golden.seedHex)).deriveUnhardenedPath([12381, 8444, 2, 0]).deriveSynthetic().publicKey();
    const coin = new w.Simulator().newCoin(w.fromHex(ph0), 1000n);
    const clvm = new w.Clvm();
    clvm.spendStandardCoin(coin, synthPk, clvm.delegatedSpend([clvm.createCoin(w.fromHex(ph0), 1000n, undefined)]));
    return toWire(w, clvm.coinSpends());
  }

  /** A standard spend by a FOREIGN sim key (the golden wallet cannot sign it). */
  function foreignWire(): WireCoinSpend[] {
    const w = chia as unknown as SpendWasm;
    const sim = new w.Simulator();
    const pair = sim.bls(1000n);
    const clvm = new w.Clvm();
    clvm.spendStandardCoin(pair.coin, pair.pk, clvm.delegatedSpend([clvm.createCoin(pair.puzzleHash, 1000n, undefined)]));
    return toWire(w, clvm.coinSpends());
  }

  it('getPublicKeys returns the wallet synthetic public keys (both schemes)', async () => {
    const v = await goldenWallet();
    const res = await v.handle({ op: 'getPublicKeys', activeIndex: 0 }, { ...deps, chia });
    expect(res.success).toBe(true);
    expect(res.publicKeys).toContain(golden.unhardened[0].syntheticPkHex);
    expect(res.publicKeys).toContain(golden.hardened[0].syntheticPkHex);
  });

  it('decodeDappSpend classifies an own coin spend as self + owned signer', async () => {
    const v = await goldenWallet();
    const res = await v.handle({ op: 'decodeDappSpend', coinSpends: goldenOwnedWire(), activeIndex: 0 }, { ...deps, chia });
    expect(res.success).toBe(true);
    expect(res.dappSummary?.coinCount).toBe(1);
    expect(res.dappSummary?.inputs[0].isSelf).toBe(true);
    expect(res.dappSummary?.allInputsSelf).toBe(true);
    expect(res.dappSummary?.ownedSigners).toBe(1);
    expect(res.dappSummary?.requiredSigners).toContain(golden.unhardened[0].syntheticPkHex);
  });

  it('signDappSpend signs an own coin spend (returns a 96-byte signature)', async () => {
    const v = await goldenWallet();
    const res = await v.handle({ op: 'signDappSpend', coinSpends: goldenOwnedWire(), activeIndex: 0 }, { ...deps, chia });
    expect(res.success).toBe(true);
    expect(res.signature).toMatch(/^[0-9a-f]{192}$/);
  });

  it('signDappSpend fails MISSING_KEY on a foreign spend the wallet cannot sign', async () => {
    const v = await goldenWallet();
    const res = await v.handle({ op: 'signDappSpend', coinSpends: foreignWire(), activeIndex: 0 }, { ...deps, chia });
    expect(res.success).toBe(false);
    expect(res.code).toBe('MISSING_KEY');
  });

  it('signMessage signs and reports the signer public key', async () => {
    const v = await goldenWallet();
    const res = await v.handle({ op: 'signMessage', message: 'hello dig', activeIndex: 0 }, { ...deps, chia });
    expect(res.success).toBe(true);
    expect(res.signature).toMatch(/^[0-9a-f]{192}$/);
    expect(res.signerPublicKey).toMatch(/^[0-9a-f]{96}$/);
  });

  it('dApp ops require an unlocked wallet + the wasm', async () => {
    expect((await new Vault().handle({ op: 'getPublicKeys' }, { ...deps, chia })).code).toBe('LOCKED');
    expect((await (await goldenWallet()).handle({ op: 'decodeDappSpend' }, { ...deps, chia })).code).toBe('BAD_REQUEST');
    expect((await (await goldenWallet()).handle({ op: 'signMessage' }, { ...deps, chia })).code).toBe('BAD_REQUEST');
    expect((await (await goldenWallet()).handle({ op: 'getPublicKeys' }, deps)).code).toBe('WASM_UNAVAILABLE');
  });
});

describe('Vault balance + address ops', () => {
  let chia: ScanWasm;
  beforeAll(async () => {
    chia = (await loadChiaWasmNode()) as ScanWasm;
  });

  async function unlockedZerosWallet(): Promise<Vault> {
    const v = new Vault();
    await v.handle({ op: 'importWallet', password: PW, mnemonic: golden.mnemonic }, deps);
    return v;
  }
  const chain = (map: Record<string, number>): ChainClient => ({
    totalUnspent: async (phs) => phs.reduce((s, ph) => s + (map[ph.toLowerCase()] ?? 0), 0),
    unspentCoins: async () => [],
    pushSpendBundle: async () => ({ success: true }),
    coinConfirmed: async () => false,
    getCoinSpend: async () => null,
    coinRecords: async () => [],
  });

  it('derives the active index (default 0) receive address for the held wallet', async () => {
    const v = await unlockedZerosWallet();
    const res = await v.handle({ op: 'getReceiveAddress' }, { ...deps, chia });
    expect(res.success).toBe(true);
    expect(res.address).toBe(golden.unhardened[0].address);
  });

  it('navigating the active index (#165) changes the receive address', async () => {
    const v = await unlockedZerosWallet();
    const res = await v.handle({ op: 'getReceiveAddress', activeIndex: 1 }, { ...deps, chia });
    expect(res.success).toBe(true);
    expect(res.address).toBe(golden.unhardened[1].address);
    expect(res.address).not.toBe(golden.unhardened[0].address);
  });

  it('scans XCH + CAT balances for the held wallet at the active index', async () => {
    const v = await unlockedZerosWallet();
    const res = await v.handle(
      { op: 'scanBalances', activeIndex: 0 },
      { ...deps, chia, chain: chain({ [golden.unhardened[0].puzzleHashHex]: 2_000_000_000_000 }) },
    );
    expect(res.balances?.xch).toBe(2_000_000_000_000);
  });

  it('scanBalances at a non-active index does not see index-0 funds — no multi-index sweep (#165)', async () => {
    const v = await unlockedZerosWallet();
    const res = await v.handle(
      { op: 'scanBalances', activeIndex: 1 },
      { ...deps, chia, chain: chain({ [golden.unhardened[0].puzzleHashHex]: 2_000_000_000_000 }) },
    );
    expect(res.balances?.xch).toBe(0);
  });

  it('returns LOCKED when no key is held', async () => {
    const res = await new Vault().handle({ op: 'getReceiveAddress' }, { ...deps, chia });
    expect(res.code).toBe('LOCKED');
  });

  it('returns CHAIN_UNAVAILABLE without a chain client', async () => {
    const v = await unlockedZerosWallet();
    const res = await v.handle({ op: 'scanBalances' }, { ...deps, chia });
    expect(res.code).toBe('CHAIN_UNAVAILABLE');
  });

  // #106 — a read-only page of BOTH-scheme derived addresses (indexes 0..count-1) for VIEWING/
  // COPYING only: pure local derivation, no chain query, and NOT a multi-index balance scan (#165
  // stays intact — this never feeds into balances/activity, only display).
  describe('listDerivedAddresses (#106)', () => {
    it('derives both schemes for indexes 0..count-1, matching the golden vectors', async () => {
      const v = await unlockedZerosWallet();
      const res = await v.handle({ op: 'listDerivedAddresses', count: 3 }, { ...deps, chia });
      expect(res.success).toBe(true);
      expect(res.addresses).toHaveLength(6); // 3 indexes × 2 schemes
      const unhardened = res.addresses!.filter((a) => a.scheme === 'unhardened');
      const hardened = res.addresses!.filter((a) => a.scheme === 'hardened');
      expect(unhardened.map((a) => a.address)).toEqual([golden.unhardened[0].address, golden.unhardened[1].address, golden.unhardened[2].address]);
      expect(hardened.map((a) => a.address)).toEqual([golden.hardened[0].address, golden.hardened[1].address, golden.hardened[2].address]);
      expect(unhardened.map((a) => a.index)).toEqual([0, 1, 2]);
    });

    it('defaults to a small page when count is omitted', async () => {
      const v = await unlockedZerosWallet();
      const res = await v.handle({ op: 'listDerivedAddresses' }, { ...deps, chia });
      expect(res.success).toBe(true);
      expect(res.addresses!.length).toBeGreaterThan(0);
      expect(res.addresses!.length).toBeLessThanOrEqual(20); // sane default page, not unbounded
    });

    it('caps an oversized count rather than deriving unboundedly', async () => {
      const v = await unlockedZerosWallet();
      const res = await v.handle({ op: 'listDerivedAddresses', count: 100000 }, { ...deps, chia });
      expect(res.success).toBe(true);
      expect(res.addresses!.length).toBeLessThanOrEqual(200); // 2 schemes × the server-side cap
    });

    it('returns LOCKED when no key is held', async () => {
      const res = await new Vault().handle({ op: 'listDerivedAddresses' }, { ...deps, chia });
      expect(res.code).toBe('LOCKED');
    });

    it('returns WASM_UNAVAILABLE without chia', async () => {
      const v = await unlockedZerosWallet();
      const res = await v.handle({ op: 'listDerivedAddresses' }, deps);
      expect(res.code).toBe('WASM_UNAVAILABLE');
    });

    it('never queries the chain — pure local derivation', async () => {
      const v = await unlockedZerosWallet();
      let called = false;
      const spyChain: ChainClient = {
        totalUnspent: async () => { called = true; return 0; },
        unspentCoins: async () => { called = true; return []; },
        pushSpendBundle: async () => ({ success: true }),
        coinConfirmed: async () => false,
        getCoinSpend: async () => null,
        coinRecords: async () => [],
      };
      await v.handle({ op: 'listDerivedAddresses', count: 5 }, { ...deps, chia, chain: spyChain });
      expect(called).toBe(false);
    });
  });

  // #96 — watch-only wallets carry NO seed at all; every read derives from a supplied master
  // PUBLIC key (`watchPublicKeyHex`) instead of the held entropy. No unlock, no password, ever.
  describe('watch-only (public-key-only) reads (#96)', () => {
    const masterPkHex = golden.masterPkHex;

    it('getReceiveAddress derives from watchPublicKeyHex with NO wallet held at all', async () => {
      const res = await new Vault().handle({ op: 'getReceiveAddress', watchPublicKeyHex: masterPkHex }, { ...deps, chia });
      expect(res.success).toBe(true);
      expect(res.address).toBe(golden.unhardened[0].address);
    });

    it('also returns the key fingerprint (a human-shareable id) for a watch-only read', async () => {
      const res = await new Vault().handle({ op: 'getReceiveAddress', watchPublicKeyHex: masterPkHex }, { ...deps, chia });
      expect(Number.isInteger(res.fingerprint)).toBe(true);
    });

    it('respects activeIndex (#165 stays a single active index, even for watch-only)', async () => {
      const res = await new Vault().handle({ op: 'getReceiveAddress', watchPublicKeyHex: masterPkHex, activeIndex: 1 }, { ...deps, chia });
      expect(res.address).toBe(golden.unhardened[1].address);
    });

    it('rejects a malformed watch public key', async () => {
      const res = await new Vault().handle({ op: 'getReceiveAddress', watchPublicKeyHex: 'not-hex' }, { ...deps, chia });
      expect(res.success).toBe(false);
      expect(res.code).toBe('INVALID_PUBLIC_KEY');
    });

    it('scanBalances derives the watch wallet\'s XCH balance at the active index (unhardened only)', async () => {
      const res = await new Vault().handle(
        { op: 'scanBalances', watchPublicKeyHex: masterPkHex, activeIndex: 0 },
        { ...deps, chia, chain: chain({ [golden.unhardened[0].puzzleHashHex]: 5_000_000_000_000 }) },
      );
      expect(res.success).toBe(true);
      expect(res.balances?.xch).toBe(5_000_000_000_000);
    });

    it('scanBalances for a watch wallet still honours an explicit watched-CAT list', async () => {
      const assetId = 'aa'.repeat(32);
      const chainWithCat: ChainClient = {
        ...chain({}),
        totalUnspent: async (phs) => phs.reduce((s) => s + 7, 0), // any CAT-puzzle-hash query resolves to a fixed nonzero amount
      };
      const res = await new Vault().handle(
        { op: 'scanBalances', watchPublicKeyHex: masterPkHex, activeIndex: 0, watchedCats: [assetId] },
        { ...deps, chia, chain: chainWithCat },
      );
      expect(res.balances?.cats[assetId]).toBeGreaterThan(0);
    });

    it('listDerivedAddresses for a watch wallet returns UNHARDENED-only rows', async () => {
      const res = await new Vault().handle({ op: 'listDerivedAddresses', watchPublicKeyHex: masterPkHex, count: 3 }, { ...deps, chia });
      expect(res.success).toBe(true);
      expect(res.addresses).toHaveLength(3); // unhardened only, not 6 — hardened is not derivable from a pubkey
      expect(res.addresses!.every((a) => a.scheme === 'unhardened')).toBe(true);
      expect(res.addresses!.map((a) => a.address)).toEqual(golden.unhardened.slice(0, 3).map((g) => g.address));
    });
  });
});

// #96 — private-key export: derives the RAW (pre-synthetic) account secret key at the active index,
// for BOTH schemes, requiring the FULL password re-auth (never from the cached unlock window) —
// exactly the same re-auth discipline `revealPhrase` already uses for the mnemonic.
describe('Vault exportPrivateKey (#96)', () => {
  let chia: ScanWasm;
  beforeAll(async () => {
    chia = (await loadChiaWasmNode()) as ScanWasm;
  });

  it('requires password + record like revealPhrase', async () => {
    const res = await new Vault().handle({ op: 'exportPrivateKey', record: {} as never }, { ...deps, chia });
    expect(res.code).toBe('BAD_REQUEST');
  });

  it('exports BOTH schemes\' raw secret keys at the active index, matching deriveWalletSecretKeyHex', async () => {
    const created = await new Vault().handle({ op: 'createWallet', password: PW }, deps);
    const res = await new Vault().handle(
      { op: 'exportPrivateKey', password: PW, record: created.record!, activeIndex: 0 },
      { ...deps, chia },
    );
    expect(res.success).toBe(true);
    expect(res.privateKeys).toHaveLength(2);
    const schemes = res.privateKeys!.map((k) => k.scheme).sort();
    expect(schemes).toEqual(['hardened', 'unhardened']);
    for (const k of res.privateKeys!) expect(k.hex).toMatch(/^[0-9a-f]{64}$/);
  });

  it('exports the golden mnemonic\'s known key at index 0 (cross-checked against derive.ts directly)', async () => {
    const imported = await new Vault().handle({ op: 'importWallet', password: PW, mnemonic: golden.mnemonic }, deps);
    const res = await new Vault().handle(
      { op: 'exportPrivateKey', password: PW, record: imported.record!, activeIndex: 0 },
      { ...deps, chia },
    );
    const unhardened = res.privateKeys!.find((k) => k.scheme === 'unhardened')!;
    const seed = await mnemonicToSeed(golden.mnemonic);
    const master = masterFromSeed(chia, seed);
    const expected = deriveWalletSecretKeyHex(chia, master, 0, 'unhardened');
    master.free?.();
    expect(unhardened.hex).toBe(expected);
  });

  it('respects the active index', async () => {
    const created = await new Vault().handle({ op: 'importWallet', password: PW, mnemonic: golden.mnemonic }, deps);
    const res0 = await new Vault().handle({ op: 'exportPrivateKey', password: PW, record: created.record!, activeIndex: 0 }, { ...deps, chia });
    const res1 = await new Vault().handle({ op: 'exportPrivateKey', password: PW, record: created.record!, activeIndex: 1 }, { ...deps, chia });
    expect(res0.privateKeys![0].hex).not.toBe(res1.privateKeys![0].hex);
  });

  it('fails opaquely on a wrong password (same UNLOCK_FAILED as revealPhrase)', async () => {
    const created = await new Vault().handle({ op: 'createWallet', password: PW }, deps);
    const res = await new Vault().handle({ op: 'exportPrivateKey', password: 'wrong', record: created.record! }, { ...deps, chia });
    expect(res.success).toBe(false);
    expect(res.code).toBe('UNLOCK_FAILED');
  });

  it('returns WASM_UNAVAILABLE without chia', async () => {
    const created = await new Vault().handle({ op: 'createWallet', password: PW }, deps);
    const res = await new Vault().handle({ op: 'exportPrivateKey', password: PW, record: created.record! }, deps);
    expect(res.code).toBe('WASM_UNAVAILABLE');
  });
});

describe('Vault send ops', () => {
  let chia: ScanWasm;
  beforeAll(async () => {
    chia = (await loadChiaWasmNode()) as ScanWasm;
  });

  async function unlockedZerosWallet(): Promise<Vault> {
    const v = new Vault();
    await v.handle({ op: 'importWallet', password: PW, mnemonic: golden.mnemonic }, deps);
    return v;
  }

  // A chain that funds the golden index-0 unhardened address and accepts the push (signature
  // correctness is proven end-to-end in sendFlow.test.ts; here we exercise the vault orchestration).
  function sendChain() {
    const wasm = chia as unknown as { Simulator: new () => { newCoin(ph: Uint8Array, a: bigint): unknown }; fromHex(h: string): Uint8Array; Address: new (ph: Uint8Array, p: string) => { encode(): string } };
    const ph0 = golden.unhardened[0].puzzleHashHex;
    const coin = new wasm.Simulator().newCoin(wasm.fromHex(ph0), 1_000_000_000_000n);
    const recipient = new wasm.Address(new Uint8Array(32).fill(9), 'xch').encode();
    const chain: ChainClient = {
      totalUnspent: async () => 0,
      unspentCoins: async (phs) => (phs.includes(ph0) ? [coin as never] : []),
      pushSpendBundle: async () => ({ success: true }),
      coinConfirmed: async () => true,
    getCoinSpend: async () => null,
    coinRecords: async () => [],
    };
    return { chain, recipient };
  }

  it('prepareSend → confirmSend → sendStatus (orchestration)', async () => {
    const v = await unlockedZerosWallet();
    const { chain, recipient } = sendChain();
    const prep = await v.handle({ op: 'prepareSend', recipient, amount: '250000000000', fee: '1000000' }, { ...deps, chia, chain });
    expect(prep.success).toBe(true);
    expect(prep.pendingId).toBeTruthy();
    expect(prep.summary?.sent).toBe('250000000000');

    const conf = await v.handle({ op: 'confirmSend', pendingId: prep.pendingId }, { ...deps, chia, chain });
    expect(conf.success).toBe(true);
    expect(conf.spentCoinId).toBeTruthy();

    // The pending entry is consumed — a second confirm is NO_PENDING.
    const again = await v.handle({ op: 'confirmSend', pendingId: prep.pendingId }, { ...deps, chia, chain });
    expect(again.code).toBe('NO_PENDING');

    const status = await v.handle({ op: 'sendStatus', coinId: conf.spentCoinId }, { ...deps, chain });
    expect(status.confirmed).toBe(true);
  });

  it('lock clears pending sends', async () => {
    const v = await unlockedZerosWallet();
    const { chain, recipient } = sendChain();
    const prep = await v.handle({ op: 'prepareSend', recipient, amount: '1000', fee: '0' }, { ...deps, chia, chain });
    v.lock();
    const conf = await v.handle({ op: 'confirmSend', pendingId: prep.pendingId }, { ...deps, chia, chain });
    expect(conf.code).toBe('NO_PENDING');
  });

  it('prepareSend requires recipient + amount', async () => {
    const v = await unlockedZerosWallet();
    const { chain } = sendChain();
    const res = await v.handle({ op: 'prepareSend', amount: '1000' }, { ...deps, chia, chain });
    expect(res.code).toBe('BAD_REQUEST');
  });

  // #105 — an optional plain-text memo attached to the recipient's CREATE_COIN, decoded back from
  // the built spend (never merely echoed) so the caller's review UI shows what will actually land
  // on chain.
  it('prepareSend forwards an optional memo, decoded back from the built spend (#105)', async () => {
    const v = await unlockedZerosWallet();
    const { chain, recipient } = sendChain();
    const prep = await v.handle({ op: 'prepareSend', recipient, amount: '1000', fee: '0', memo: 'thanks!' }, { ...deps, chia, chain });
    expect(prep.success).toBe(true);
    expect(prep.summary?.memoText).toBe('thanks!');
  });

  it('prepareSend omits memoText when no memo is given', async () => {
    const v = await unlockedZerosWallet();
    const { chain, recipient } = sendChain();
    const prep = await v.handle({ op: 'prepareSend', recipient, amount: '1000', fee: '0' }, { ...deps, chia, chain });
    expect(prep.summary?.memoText).toBeUndefined();
  });

  it('rejects a memo combined with a clawback send (v1)', async () => {
    const v = await unlockedZerosWallet();
    const { chain, recipient } = sendChain();
    const res = await v.handle(
      { op: 'prepareSend', recipient, amount: '1000', fee: '0', memo: 'note', clawbackSeconds: '999999999999' },
      { ...deps, chia, chain },
    );
    expect(res.success).toBe(false);
    expect(res.code).toBe('BAD_REQUEST');
  });

  it('rejects a memo longer than the max byte length', async () => {
    const v = await unlockedZerosWallet();
    const { chain, recipient } = sendChain();
    const res = await v.handle({ op: 'prepareSend', recipient, amount: '1000', fee: '0', memo: 'x'.repeat(600) }, { ...deps, chia, chain });
    expect(res.success).toBe(false);
    expect(res.code).toBe('BAD_REQUEST');
  });

  // #154 — confirmSend hands back the activity-log hint captured at prepare time (asset/amount/
  // counterparty) so the SW can log a LOCAL 'sent' entry without any on-chain reconstruction.
  it('confirmSend returns the #154 activityHint captured at prepareSend time', async () => {
    const v = await unlockedZerosWallet();
    const { chain, recipient } = sendChain();
    const prep = await v.handle({ op: 'prepareSend', recipient, amount: '250000000000', fee: '1000000' }, { ...deps, chia, chain });
    const conf = await v.handle({ op: 'confirmSend', pendingId: prep.pendingId }, { ...deps, chia, chain });
    expect(conf.success).toBe(true);
    expect(conf.activityHint).toEqual({ asset: 'XCH', amount: '250000000000', counterparty: recipient });
  });
});

describe('Vault NFT bulk transfer + burn ops (#171)', () => {
  let chia: ScanWasm;
  beforeAll(async () => {
    chia = (await loadChiaWasmNode()) as ScanWasm;
  });

  async function unlockedZerosWallet(): Promise<Vault> {
    const v = new Vault();
    await v.handle({ op: 'importWallet', password: PW, mnemonic: golden.mnemonic }, deps);
    return v;
  }

  interface SimHandle {
    newCoin(ph: Uint8Array, amount: bigint): { coinId(): Uint8Array };
    newTransaction(bundle: unknown): void;
    createBlock(): void;
    unspentCoins(ph: Uint8Array, includeHints: boolean): never[];
    coinSpend(coinId: Uint8Array): unknown;
  }
  interface BulkWasm {
    Simulator: new () => SimHandle;
    fromHex(h: string): Uint8Array;
    toHex(b: Uint8Array): string;
    Address: new (ph: Uint8Array, p: string) => { encode(): string };
    Clvm: new () => {
      nftMetadata(v: unknown): unknown;
      standardSpend(pk: unknown, s: unknown): unknown;
      delegatedSpend(c: unknown[]): unknown;
      coinSpends(): unknown[];
    };
    Spends: new (
      c: unknown,
      ph: Uint8Array,
    ) => {
      addXch(c: unknown): void;
      apply(a: unknown[]): unknown;
      prepare(d: unknown): {
        pendingSpends(): Array<{ coin(): { coinId(): Uint8Array }; conditions(): unknown[] }>;
        insert(id: Uint8Array, s: unknown): void;
        spend(): { nfts(): unknown[]; nft(id: unknown): { info: { launcherId: Uint8Array } } };
      };
    };
    NftMetadata: new (
      editionNumber: bigint,
      editionTotal: bigint,
      dataUris: string[],
      dataHash: Uint8Array | undefined,
      metadataUris: string[],
      metadataHash: Uint8Array | undefined,
      licenseUris: string[],
    ) => unknown;
    Constants: { nftMetadataUpdaterDefaultHash(): Uint8Array };
    Action: { mintNft(c: unknown, m: unknown, u: Uint8Array, r: Uint8Array, bps: number, amt: bigint, parent?: unknown): unknown };
  }

  // A chain fully backed by the wasm Simulator (unlike `sendChain`'s fixed single coin, NFT ops need
  // hint-based discovery + parent-spend lookups too) — same shape as nfts.test.ts's `simChain`.
  // `pushSpendBundle` is STUBBED (like the existing `sendChain()` above), NOT a real Simulator push:
  // vault.ts's `confirmSend` hardcodes `MAINNET_AGG_SIG_ME`, which the Simulator's own genesis does
  // not accept, so a real push here would fail signature verification. The NFTs this suite bulk-
  // transfers/burns are minted DIRECTLY against the Simulator below (signed with the Simulator's own
  // `TESTNET11_AGG_SIG_ME`, exactly like nfts.test.ts) so `coinsByHints`/`getCoinSpend` genuinely see
  // them; the real broadcast-and-rediscover round trip is proven end-to-end there, not re-proven here
  // — this suite is scoped to the vault's BULK orchestration (pending map, activityHint, NO_PENDING).
  function bulkChain() {
    const wasm = chia as unknown as BulkWasm;
    const sim = new wasm.Simulator();
    sim.newCoin(wasm.fromHex(golden.unhardened[0].puzzleHashHex), 5_000_000_000_000n);
    const chain: ChainClient = {
      totalUnspent: async () => 0,
      unspentCoins: async (phs) => phs.flatMap((h) => sim.unspentCoins(wasm.fromHex(h), false)),
      coinRecords: async () => [],
      getCoinSpend: async (idHex) => (sim.coinSpend(wasm.fromHex(idHex)) as never) ?? null,
      pushSpendBundle: async () => ({ success: true }),
      coinConfirmed: async () => true,
      coinsByHints: async (hints) => hints.flatMap((h) => sim.unspentCoins(wasm.fromHex(h), true)),
    };
    return { chain, sim, wasm };
  }

  /** Mint one NFT directly against the Simulator (mirrors nfts.test.ts's `mintNftTo`) — bypasses the
   * vault's `confirmSend` (which would need a mainnet-domain signature the Simulator can't verify). */
  function mintNftDirect(sim: SimHandle, wasm: BulkWasm, ring0: ReturnType<typeof buildKeyring>[number]): string {
    const ph0 = wasm.fromHex(ring0.puzzleHashHex);
    const clvm = new wasm.Clvm();
    const spends = new wasm.Spends(clvm, ph0);
    spends.addXch(sim.unspentCoins(ph0, false)[0]);
    const metadata = clvm.nftMetadata(new wasm.NftMetadata(1n, 1n, ['https://example.test/img.png'], undefined, [], undefined, []));
    const mintAction = wasm.Action.mintNft(clvm, metadata, wasm.Constants.nftMetadataUpdaterDefaultHash(), ph0, 0, 1n, undefined);
    const fin = spends.prepare(spends.apply([mintAction]));
    for (const ps of fin.pendingSpends()) fin.insert(ps.coin().coinId(), clvm.standardSpend(ring0.pk, clvm.delegatedSpend(ps.conditions())));
    const outputs = fin.spend();
    const launcherId = wasm.toHex(outputs.nft(outputs.nfts()[0]).info.launcherId).replace(/^0x/i, '').toLowerCase();
    const bundle = signAndBundle(wasm as unknown as SendFlowWasm, clvm.coinSpends() as never, [ring0.sk], TESTNET11_AGG_SIG_ME);
    sim.newTransaction(bundle);
    sim.createBlock();
    return launcherId;
  }

  it('prepareNftBulkTransfer → confirmSend moves multiple NFTs in ONE bundle and logs a `sent` hint', async () => {
    const v = await unlockedZerosWallet();
    const { chain, sim, wasm } = bulkChain();
    const ring0 = buildKeyring(wasm as unknown as SendFlowWasm, await mnemonicToSeed(golden.mnemonic), { index: 0 })[0];
    const id1 = mintNftDirect(sim, wasm, ring0);
    const id2 = mintNftDirect(sim, wasm, ring0);
    const recipient = new wasm.Address(new Uint8Array(32).fill(9), 'xch').encode();

    const prep = await v.handle({ op: 'prepareNftBulkTransfer', launcherIds: [id1, id2], recipient }, { ...deps, chia, chain });
    expect(prep.success).toBe(true);
    expect(prep.pendingId).toBeTruthy();
    expect(prep.nftBulkSummary?.launcherIds.slice().sort()).toEqual([id1, id2].sort());
    expect(prep.nftBulkSummary?.isBurn).toBe(false);

    const conf = await v.handle({ op: 'confirmSend', pendingId: prep.pendingId }, { ...deps, chia, chain });
    expect(conf.success).toBe(true);
    expect(conf.spentCoinId).toBeTruthy();
    expect(conf.activityHint).toEqual({ asset: 'NFT', amount: '2', counterparty: recipient });

    // The pending entry is consumed — a second confirm is NO_PENDING.
    expect((await v.handle({ op: 'confirmSend', pendingId: prep.pendingId }, { ...deps, chia, chain })).code).toBe('NO_PENDING');
  });

  it('prepareNftBulkBurn → confirmSend burns multiple NFTs and logs a hint with NO counterparty', async () => {
    const v = await unlockedZerosWallet();
    const { chain, sim, wasm } = bulkChain();
    const ring0 = buildKeyring(wasm as unknown as SendFlowWasm, await mnemonicToSeed(golden.mnemonic), { index: 0 })[0];
    const id1 = mintNftDirect(sim, wasm, ring0);
    const id2 = mintNftDirect(sim, wasm, ring0);

    const prep = await v.handle({ op: 'prepareNftBulkBurn', launcherIds: [id1, id2] }, { ...deps, chia, chain });
    expect(prep.success).toBe(true);
    expect(prep.nftBulkSummary?.isBurn).toBe(true);

    const conf = await v.handle({ op: 'confirmSend', pendingId: prep.pendingId }, { ...deps, chia, chain });
    expect(conf.success).toBe(true);
    expect(conf.activityHint).toEqual({ asset: 'NFT', amount: '2', counterparty: null });
  });

  it('rejects prepareNftBulkTransfer/prepareNftBulkBurn with no launcherIds (BAD_REQUEST, no chain hit)', async () => {
    const v = await unlockedZerosWallet();
    const { chain, wasm } = bulkChain();
    const recipient = new wasm.Address(new Uint8Array(32).fill(9), 'xch').encode();
    expect((await v.handle({ op: 'prepareNftBulkTransfer', launcherIds: [], recipient }, { ...deps, chia, chain })).code).toBe('BAD_REQUEST');
    expect((await v.handle({ op: 'prepareNftBulkTransfer', recipient }, { ...deps, chia, chain })).code).toBe('BAD_REQUEST');
    expect((await v.handle({ op: 'prepareNftBulkBurn', launcherIds: [] }, { ...deps, chia, chain })).code).toBe('BAD_REQUEST');
  });

  it('rejects a bulk transfer with no held key (LOCKED)', async () => {
    const v = new Vault(); // never unlocked
    const { chain, wasm } = bulkChain();
    const recipient = new wasm.Address(new Uint8Array(32).fill(9), 'xch').encode();
    expect((await v.handle({ op: 'prepareNftBulkTransfer', launcherIds: ['ab'.repeat(32)], recipient }, { ...deps, chia, chain })).code).toBe('LOCKED');
    expect((await v.handle({ op: 'prepareNftBulkBurn', launcherIds: ['ab'.repeat(32)] }, { ...deps, chia, chain })).code).toBe('LOCKED');
  });
});

describe('Vault clawback ops (#152)', () => {
  let chia: ScanWasm;
  beforeAll(async () => {
    chia = (await loadChiaWasmNode()) as ScanWasm;
  });

  async function unlockedZerosWallet(): Promise<Vault> {
    const v = new Vault();
    await v.handle({ op: 'importWallet', password: PW, mnemonic: golden.mnemonic }, deps);
    return v;
  }

  interface SimHandle {
    newCoin(ph: Uint8Array, a: bigint): { coinId(): Uint8Array; parentCoinInfo: Uint8Array; puzzleHash: Uint8Array; amount: bigint };
    newTransaction(b: unknown): void;
    createBlock(): void;
    nextTimestamp(): bigint;
    unspentCoins(ph: Uint8Array, includeHints: boolean): unknown[];
    coinSpend(id: Uint8Array): unknown;
  }
  interface SimWasm {
    Simulator: new () => SimHandle;
    fromHex(h: string): Uint8Array;
    toHex(b: Uint8Array): string;
    Address: new (ph: Uint8Array, p: string) => { encode(): string };
  }

  /**
   * A chain funding the golden index-0 unhardened address, with real hint lookups against the wasm
   * Simulator. `pushSpendBundle` is a STUB (matches `sendChain()`'s established convention above) —
   * the vault's production `confirmSend` hardcodes the MAINNET AGG_SIG_ME domain (correctly, for real
   * broadcasts), which the Simulator's own genesis does not accept, so a real push through the vault
   * would spuriously fail here on signature validation alone. These tests exercise vault
   * ORCHESTRATION (pending-id handling, wire (de)serialization, BAD_REQUEST/MISSING_KEY guards) —
   * deep consensus correctness (timelock enforcement, signature validity, coin math) is fully proven
   * in `clawback.test.ts` against the domain-correct testnet11 constant. Real on-chain state (so
   * `listClawbacks`'s hint discovery has something to find) is seeded directly via
   * {@link seedClawbackSend}, which signs for the SAME domain the Simulator actually accepts.
   */
  function clawbackChain() {
    const wasm = chia as unknown as SimWasm;
    const sim = new wasm.Simulator();
    const ph0 = golden.unhardened[0].puzzleHashHex;
    sim.newCoin(wasm.fromHex(ph0), 1_000_000_000_000n);
    const receiverPh = golden.unhardened[2].puzzleHashHex;
    const recipient = new wasm.Address(wasm.fromHex(receiverPh), 'xch').encode();
    const chain: ChainClient = {
      totalUnspent: async () => 0,
      unspentCoins: async (phs) => phs.flatMap((h) => sim.unspentCoins(wasm.fromHex(h), false) as never[]),
      coinsByHints: async (hints) => hints.flatMap((h) => sim.unspentCoins(wasm.fromHex(h), true) as never[]),
      pushSpendBundle: async () => ({ success: true }),
      coinConfirmed: async () => true,
      getCoinSpend: async (idHex) => (sim.coinSpend(wasm.fromHex(idHex)) as never) ?? null,
      coinRecords: async () => [],
    };
    return { sim, wasm, chain, recipient, receiverIndex: 2 };
  }

  /** Build + sign (testnet11 domain, matching the Simulator's genesis) + push a send-with-clawback
   * DIRECTLY against the sim, bypassing the vault's confirmSend (see {@link clawbackChain}'s doc). */
  async function seedClawbackSend(sim: SimHandle, wasm: SimWasm, recipient: string, seconds: bigint, amount = 250_000_000_000n) {
    const seed = await mnemonicToSeed(golden.mnemonic);
    const seedChain: ChainClient = {
      totalUnspent: async () => 0,
      unspentCoins: async (phs) => phs.flatMap((h) => sim.unspentCoins(wasm.fromHex(h), false) as never[]),
      coinsByHints: async () => [],
      pushSpendBundle: async () => ({ success: true }),
      coinConfirmed: async () => true,
      getCoinSpend: async () => null,
      coinRecords: async () => [],
    };
    const prepared = await prepareXchSend(chia as unknown as SendFlowWasm, seedChain, {
      seed,
      recipient,
      amount,
      fee: 0n,
      activeIndex: 0,
      clawbackSeconds: seconds,
    });
    const bundle = signAndBundle(chia as unknown as SendFlowWasm, prepared.coinSpends, prepared.secretKeys, TESTNET11_AGG_SIG_ME);
    sim.newTransaction(bundle);
    sim.createBlock();
    return prepared.clawbackInfo!;
  }

  const toWire = (i: ClawbackInfo) => ({
    senderPuzzleHashHex: i.senderPuzzleHashHex,
    receiverPuzzleHashHex: i.receiverPuzzleHashHex,
    seconds: i.seconds.toString(),
    amount: i.amount.toString(),
  });

  it('prepareSend clawbackSeconds locks the coin under a distinct puzzle hash and returns clawbackInfo', async () => {
    const v = await unlockedZerosWallet();
    const { sim, chain, recipient } = clawbackChain();
    const seconds = (sim.nextTimestamp() + 3600n).toString();
    const prep = await v.handle(
      { op: 'prepareSend', recipient, amount: '250000000000', fee: '0', clawbackSeconds: seconds },
      { ...deps, chia, chain },
    );
    expect(prep.success).toBe(true);
    expect(prep.clawbackInfo).toBeDefined();
    expect(prep.clawbackInfo?.seconds).toBe(seconds);
    expect(prep.clawbackInfo?.amount).toBe('250000000000');
    expect(prep.summary?.recipientPuzzleHashHex).not.toBe(golden.unhardened[2].puzzleHashHex); // locked, not the plain receiver address

    const conf = await v.handle({ op: 'confirmSend', pendingId: prep.pendingId }, { ...deps, chia, chain });
    expect(conf.success).toBe(true);
    // #152 — confirmSend hands the SAME clawbackInfo back (so the caller can persist it for later).
    expect(conf.clawbackInfo).toEqual(prep.clawbackInfo);
  });

  it('a CAT send with clawbackSeconds is rejected (v1 is XCH-only)', async () => {
    const v = await unlockedZerosWallet();
    const { chain, recipient } = clawbackChain();
    const res = await v.handle(
      { op: 'prepareSend', recipient, amount: '1000', fee: '0', assetId: 'ab'.repeat(32), clawbackSeconds: '999999999999' },
      { ...deps, chia, chain },
    );
    expect(res.success).toBe(false);
    expect(res.code).toBe('BAD_REQUEST');
  });

  it('listClawbacks discovers the incoming pending clawback for the receiver’s wallet', async () => {
    const { sim, wasm, chain, recipient, receiverIndex } = clawbackChain();
    const info = await seedClawbackSend(sim, wasm, recipient, sim.nextTimestamp() + 3600n);

    // The SAME wallet, viewed at the RECEIVER's active index, discovers it by hint.
    const receiver = await unlockedZerosWallet();
    const list = await receiver.handle({ op: 'listClawbacks', activeIndex: receiverIndex }, { ...deps, chia, chain });
    expect(list.success).toBe(true);
    expect(list.clawbacks).toHaveLength(1);
    expect(list.clawbacks?.[0]?.direction).toBe('incoming');
    expect(list.clawbacks?.[0]?.info).toEqual(toWire(info));
  });

  it('listClawbacks reports an OUTGOING candidate only while it is still actually pending on chain', async () => {
    const { sim, wasm, chain, recipient } = clawbackChain();
    const info = await seedClawbackSend(sim, wasm, recipient, sim.nextTimestamp() + 3600n);
    const candidate = toWire(info);

    const v = await unlockedZerosWallet();
    const before = await v.handle({ op: 'listClawbacks', activeIndex: 0, clawbackCandidates: [candidate] }, { ...deps, chia, chain });
    expect(before.clawbacks?.some((c) => c.direction === 'outgoing')).toBe(true);

    // Reclaim it DIRECTLY on the sim (testnet11 domain) — mirrors what a real broadcast would do —
    // then re-list: it must no longer be reported as a pending outgoing candidate.
    const keyring = buildKeyring(chia as unknown as SendFlowWasm, await mnemonicToSeed(golden.mnemonic), { index: 0 });
    const reclaimed = await prepareClawbackAction(chia as unknown as ClawbackWasm, chain, { keyring, info, direction: 'reclaim', fee: 0n });
    const reclaimBundle = signAndBundle(chia as unknown as SendFlowWasm, reclaimed.coinSpends, reclaimed.secretKeys, TESTNET11_AGG_SIG_ME);
    sim.newTransaction(reclaimBundle);
    sim.createBlock();

    const after = await v.handle({ op: 'listClawbacks', activeIndex: 0, clawbackCandidates: [candidate] }, { ...deps, chia, chain });
    expect(after.clawbacks?.some((c) => c.direction === 'outgoing')).toBe(false);
  });

  it('prepareClawbackAction (reclaim) builds + confirmSend consumes the pending entry (orchestration)', async () => {
    const { sim, wasm, chain, recipient } = clawbackChain();
    const info = await seedClawbackSend(sim, wasm, recipient, sim.nextTimestamp() + 3600n);

    const v = await unlockedZerosWallet();
    const reclaim = await v.handle(
      { op: 'prepareClawbackAction', activeIndex: 0, direction: 'reclaim', clawbackInfo: toWire(info), fee: '1000' },
      { ...deps, chia, chain },
    );
    expect(reclaim.success).toBe(true);
    expect(reclaim.clawbackAmountOut).toBe('249999999000');

    const conf = await v.handle({ op: 'confirmSend', pendingId: reclaim.pendingId }, { ...deps, chia, chain });
    expect(conf.success).toBe(true);
    expect(conf.spentCoinId).toBeTruthy();

    // The pending entry is consumed — a second confirm is NO_PENDING (mirrors the plain-send test above).
    const again = await v.handle({ op: 'confirmSend', pendingId: reclaim.pendingId }, { ...deps, chia, chain });
    expect(again.code).toBe('NO_PENDING');
  });

  it('prepareClawbackAction requires clawbackInfo + direction', async () => {
    const v = await unlockedZerosWallet();
    const { chain } = clawbackChain();
    const res = await v.handle({ op: 'prepareClawbackAction', activeIndex: 0 }, { ...deps, chia, chain });
    expect(res.code).toBe('BAD_REQUEST');
  });

  it('prepareClawbackAction NO_CLAWBACK_COIN when nothing matching is pending on chain', async () => {
    const v = await unlockedZerosWallet();
    const { chain } = clawbackChain();
    const bogus = {
      senderPuzzleHashHex: golden.unhardened[0].puzzleHashHex,
      receiverPuzzleHashHex: golden.unhardened[2].puzzleHashHex,
      seconds: '9999999999',
      amount: '1000',
    };
    const res = await v.handle({ op: 'prepareClawbackAction', activeIndex: 0, direction: 'reclaim', clawbackInfo: bogus }, { ...deps, chia, chain });
    expect(res.success).toBe(false);
    // #179: `handle()` now surfaces the domain-specific code instead of collapsing every throw to
    // the generic `VAULT_ERROR` — this test's own name always said `NO_CLAWBACK_COIN`.
    expect(res.code).toBe('NO_CLAWBACK_COIN');
  });

  it('prepareClawbackAction (claim) fails when this wallet does not own the receiver address', async () => {
    const { sim, wasm, chain, recipient } = clawbackChain();
    const info = await seedClawbackSend(sim, wasm, recipient, sim.nextTimestamp() + 3600n);

    // Viewed at index 0 (the SENDER's own index) — it does not own the RECEIVER's address (index 2).
    const v = await unlockedZerosWallet();
    const res = await v.handle(
      { op: 'prepareClawbackAction', activeIndex: 0, direction: 'claim', clawbackInfo: toWire(info) },
      { ...deps, chia, chain },
    );
    expect(res.success).toBe(false);
    // #179: surfaces the real `MISSING_KEY` code rather than the generic `VAULT_ERROR`.
    expect(res.code).toBe('MISSING_KEY');
  });
});

describe('Vault trade ops', () => {
  let chia: ScanWasm;
  beforeAll(async () => {
    chia = (await loadChiaWasmNode()) as ScanWasm;
  });

  async function unlockedZerosWallet(): Promise<Vault> {
    const v = new Vault();
    await v.handle({ op: 'importWallet', password: PW, mnemonic: golden.mnemonic }, deps);
    return v;
  }

  // A chain that funds the golden index-0 address and accepts pushes (offer signatures/settlement are
  // proven end-to-end in offers.test.ts; here we exercise the vault orchestration + wire conversion).
  function tradeChain() {
    const wasm = chia as unknown as { Simulator: new () => { newCoin(ph: Uint8Array, a: bigint): unknown }; fromHex(h: string): Uint8Array };
    const ph0 = golden.unhardened[0].puzzleHashHex;
    const coin = new wasm.Simulator().newCoin(wasm.fromHex(ph0), 5_000_000_000_000n);
    const chain: ChainClient = {
      totalUnspent: async () => 0,
      unspentCoins: async (phs) => (phs.includes(ph0) ? [coin as never] : []),
      pushSpendBundle: async () => ({ success: true }),
      coinConfirmed: async () => true,
      getCoinSpend: async () => null,
      coinRecords: async () => [],
    };
    return chain;
  }
  const CAT = 'aa'.repeat(32);
  const offerXchForCat = { offered: [{ asset: { kind: 'xch' as const }, amount: '100000000000' }], requested: [{ asset: { kind: 'cat' as const, assetId: CAT }, amount: '250' }] };

  it('makeOffer builds an offer1… string + two-sided summary; inspectOffer round-trips it', async () => {
    const v = await unlockedZerosWallet();
    const chain = tradeChain();
    const made = await v.handle({ op: 'makeOffer', ...offerXchForCat, activeIndex: 0 }, { ...deps, chia, chain });
    expect(made.success).toBe(true);
    expect(made.offer?.startsWith('offer1')).toBe(true);
    expect(made.offerSummary?.offered[0]).toEqual({ asset: { kind: 'xch' }, amount: '100000000000' });
    // #101 — the poll key every real offered coin id, surfaced so the SW can persist an offer-log
    // entry and later detect a take/cancel via a cheap coin-spent check.
    expect(made.offerCoinIds?.length).toBeGreaterThan(0);

    const seen = await v.handle({ op: 'inspectOffer', offerStr: made.offer! }, { ...deps, chia, chain });
    expect(seen.success).toBe(true);
    expect(seen.offerSummary?.offered[0]).toEqual({ asset: { kind: 'xch' }, amount: '100000000000' });
    expect(seen.offerSummary?.requested[0].asset).toEqual({ kind: 'cat', assetId: CAT });
    expect(seen.offerSummary?.requested[0].amount).toBe('250');
  });

  it('makeOffer (#100) accepts MULTIPLE requested legs in one offer', async () => {
    const v = await unlockedZerosWallet();
    const chain = tradeChain();
    const CAT2 = 'cc'.repeat(32);
    // Multi-REQUESTED (rather than multi-OFFERED) so this orchestration-level test doesn't need the
    // mock chain to source real CAT coins for a second offered asset — that path is proven end-to-end
    // against the wasm Simulator in offers.test.ts's MULTI 1/2 cases.
    const multi = {
      offered: [{ asset: { kind: 'xch' as const }, amount: '100000000000' }],
      requested: [
        { asset: { kind: 'cat' as const, assetId: CAT }, amount: '250' },
        { asset: { kind: 'cat' as const, assetId: CAT2 }, amount: '10' },
      ],
    };
    const made = await v.handle({ op: 'makeOffer', ...multi, activeIndex: 0 }, { ...deps, chia, chain });
    expect(made.success).toBe(true);
    expect(made.offerSummary?.requested).toHaveLength(2);
  });

  it('prepareTrade(cancel) → confirmTrade broadcasts a self-spend; a second confirm is NO_PENDING', async () => {
    const v = await unlockedZerosWallet();
    const chain = tradeChain();
    const made = await v.handle({ op: 'makeOffer', ...offerXchForCat, activeIndex: 0 }, { ...deps, chia, chain });
    const prep = await v.handle({ op: 'prepareTrade', offerStr: made.offer!, tradeKind: 'cancel', activeIndex: 0 }, { ...deps, chia, chain });
    expect(prep.success).toBe(true);
    expect(prep.pendingId).toBeTruthy();
    const conf = await v.handle({ op: 'confirmTrade', pendingId: prep.pendingId }, { ...deps, chia, chain });
    expect(conf.success).toBe(true);
    expect(conf.spentCoinId).toBeTruthy();
    const again = await v.handle({ op: 'confirmTrade', pendingId: prep.pendingId }, { ...deps, chia, chain });
    expect(again.code).toBe('NO_PENDING');
  });

  // #154 — confirmTrade ALWAYS hands back an activity-log hint (never undefined), even for a CANCEL,
  // whose offers.ts summary is currently always empty (it reclaims the maker's coins without
  // reconstructing a two-sided summary) — the generic XCH/0 placeholder still logs a real entry.
  it('confirmTrade returns a #154 activityHint even for a cancel (empty offers.ts summary)', async () => {
    const v = await unlockedZerosWallet();
    const chain = tradeChain();
    const made = await v.handle({ op: 'makeOffer', ...offerXchForCat, activeIndex: 0 }, { ...deps, chia, chain });
    const prep = await v.handle({ op: 'prepareTrade', offerStr: made.offer!, tradeKind: 'cancel', activeIndex: 0 }, { ...deps, chia, chain });
    const conf = await v.handle({ op: 'confirmTrade', pendingId: prep.pendingId }, { ...deps, chia, chain });
    expect(conf.activityHint).toEqual({ asset: 'XCH', amount: '0', counterparty: null });
  });

  it('lock clears pending trades', async () => {
    const v = await unlockedZerosWallet();
    const chain = tradeChain();
    const made = await v.handle({ op: 'makeOffer', ...offerXchForCat, activeIndex: 0 }, { ...deps, chia, chain });
    const prep = await v.handle({ op: 'prepareTrade', offerStr: made.offer!, tradeKind: 'cancel', activeIndex: 0 }, { ...deps, chia, chain });
    v.lock();
    const conf = await v.handle({ op: 'confirmTrade', pendingId: prep.pendingId }, { ...deps, chia, chain });
    expect(conf.code).toBe('NO_PENDING');
  });

  it('guards: BAD_REQUEST / LOCKED / CHAIN_UNAVAILABLE / WASM_UNAVAILABLE / NO_PENDING', async () => {
    const v = await unlockedZerosWallet();
    const chain = tradeChain();
    expect((await v.handle({ op: 'makeOffer', activeIndex: 0 }, { ...deps, chia, chain })).code).toBe('BAD_REQUEST');
    expect((await v.handle({ op: 'inspectOffer' }, { ...deps, chia })).code).toBe('BAD_REQUEST');
    expect((await v.handle({ op: 'prepareTrade', tradeKind: 'take' }, { ...deps, chia, chain })).code).toBe('BAD_REQUEST');
    expect((await v.handle({ op: 'makeOffer', ...offerXchForCat }, { ...deps, chia })).code).toBe('CHAIN_UNAVAILABLE');
    expect((await v.handle({ op: 'inspectOffer', offerStr: 'offer1x' }, { ...deps })).code).toBe('WASM_UNAVAILABLE');
    expect((await v.handle({ op: 'confirmTrade', pendingId: 'nope' }, { ...deps, chia, chain })).code).toBe('NO_PENDING');
    // LOCKED: a fresh (no key) vault can't make an offer.
    expect((await new Vault().handle({ op: 'makeOffer', ...offerXchForCat }, { ...deps, chia, chain })).code).toBe('LOCKED');
  });
});

describe('Vault dApp asset ops (getAssetBalance / getAssetCoins)', () => {
  let chia: ScanWasm;
  beforeAll(async () => {
    chia = (await loadChiaWasmNode()) as ScanWasm;
  });

  async function unlockedZerosWallet(): Promise<Vault> {
    const v = new Vault();
    await v.handle({ op: 'importWallet', password: PW, mnemonic: golden.mnemonic }, deps);
    return v;
  }

  const strip0x = (h: string): string => h.replace(/^0x/i, '').toLowerCase();
  const CAT = 'bb'.repeat(32);

  // A chain that funds the golden index-0 unhardened p2 hash with XCH coins, and its CAT puzzle hash
  // (for the same inner hash) with a CAT coin — so asset routing (XCH vs CAT by assetId) is exercised
  // through the REAL derivation, guarding the #121-class asset-drop bug at the vault layer.
  function assetChain() {
    const wasm = chia as unknown as { Simulator: new () => { newCoin(ph: Uint8Array, a: bigint): { coinId(): Uint8Array } }; fromHex(h: string): Uint8Array };
    const sim = new wasm.Simulator();
    const ph0 = golden.unhardened[0].puzzleHashHex;
    const catPh0 = strip0x(chia.toHex(chia.catPuzzleHash(chia.fromHex(CAT), chia.fromHex(ph0))));
    const xchCoinA = sim.newCoin(wasm.fromHex(ph0), 2_000_000_000_000n);
    const xchCoinB = sim.newCoin(wasm.fromHex(ph0), 500_000_000_000n);
    const catCoin = sim.newCoin(wasm.fromHex(catPh0), 250n);
    const chain: ChainClient = {
      totalUnspent: async () => 0,
      unspentCoins: async (phs) => {
        if (phs.map((p) => p.toLowerCase()).includes(ph0)) return [xchCoinA, xchCoinB] as never;
        if (phs.map((p) => p.toLowerCase()).includes(catPh0)) return [catCoin] as never;
        return [];
      },
      pushSpendBundle: async () => ({ success: true }),
      coinConfirmed: async () => false,
      getCoinSpend: async () => null,
      coinRecords: async () => [],
    };
    return chain;
  }

  it('getAssetBalance sums the wallet\'s unspent XCH coins (confirmed = spendable, with a count)', async () => {
    const v = await unlockedZerosWallet();
    const res = await v.handle({ op: 'getAssetBalance', activeIndex: 0 }, { ...deps, chia, chain: assetChain() });
    expect(res.success).toBe(true);
    expect(res.assetBalance).toEqual({ confirmed: '2500000000000', spendable: '2500000000000', spendableCoinCount: 2 });
  });

  it('getAssetBalance routes a CAT assetId to its CAT puzzle hash (asset-generic, guards #121)', async () => {
    const v = await unlockedZerosWallet();
    const res = await v.handle({ op: 'getAssetBalance', assetId: CAT, activeIndex: 0 }, { ...deps, chia, chain: assetChain() });
    expect(res.success).toBe(true);
    expect(res.assetBalance).toEqual({ confirmed: '250', spendable: '250', spendableCoinCount: 1 });
  });

  it('getAssetCoins returns the wallet\'s spendable coins (coin identity + name, unlocked)', async () => {
    const v = await unlockedZerosWallet();
    const res = await v.handle({ op: 'getAssetCoins', activeIndex: 0 }, { ...deps, chia, chain: assetChain() });
    expect(res.success).toBe(true);
    expect(res.assetCoins?.length).toBe(2);
    const c0 = res.assetCoins![0];
    expect(c0.coin.puzzleHash).toBe(golden.unhardened[0].puzzleHashHex);
    expect(c0.coin.amount).toBe('2000000000000');
    expect(typeof c0.coinName).toBe('string');
    expect(c0.coinName.length).toBe(64);
    expect(c0.locked).toBe(false);
  });

  it('getAssetCoins routes a CAT assetId to its CAT coins', async () => {
    const v = await unlockedZerosWallet();
    const res = await v.handle({ op: 'getAssetCoins', assetId: CAT, activeIndex: 0 }, { ...deps, chia, chain: assetChain() });
    expect(res.success).toBe(true);
    expect(res.assetCoins?.length).toBe(1);
    expect(res.assetCoins![0].coin.amount).toBe('250');
  });

  it('is LOCKED without a held key, CHAIN_UNAVAILABLE without a chain', async () => {
    expect((await new Vault().handle({ op: 'getAssetBalance' }, { ...deps, chia, chain: assetChain() })).code).toBe('LOCKED');
    const v = await unlockedZerosWallet();
    expect((await v.handle({ op: 'getAssetBalance' }, { ...deps, chia })).code).toBe('CHAIN_UNAVAILABLE');
  });
});

describe('Vault dApp broadcast op (sendTransaction)', () => {
  let chia: ScanWasm;
  beforeAll(async () => {
    chia = (await loadChiaWasmNode()) as ScanWasm;
  });

  interface SimWasm {
    fromHex(hex: string): Uint8Array;
    toHex(bytes: Uint8Array): string;
    Simulator: new () => { bls(amount: bigint): { sk: { sign(m: Uint8Array): unknown }; pk: { toBytes(): Uint8Array }; puzzleHash: Uint8Array; coin: unknown } };
    Clvm: new () => { delegatedSpend(c: unknown[]): unknown; createCoin(ph: Uint8Array, a: bigint, m: undefined): unknown; spendStandardCoin(coin: unknown, key: unknown, spend: unknown): void; coinSpends(): Array<{ coin: { parentCoinInfo: Uint8Array; puzzleHash: Uint8Array; amount: bigint }; puzzleReveal: Uint8Array; solution: Uint8Array }> };
  }

  // A REAL self-signed bundle from the Simulator → its wire coin spends + aggregated signature, exactly
  // as a dApp would hand `sendTransaction({ spendBundle })`. Proves the broadcast op reassembles a
  // valid SpendBundle (not a mocked handler) — the money-critical bar.
  function signedBundleWire() {
    const w = chia as unknown as SimWasm;
    const sim = new w.Simulator();
    const pair = sim.bls(1000n);
    const clvm = new w.Clvm();
    clvm.spendStandardCoin(pair.coin, pair.pk, clvm.delegatedSpend([clvm.createCoin(pair.puzzleHash, 1000n, undefined)]));
    const cs = clvm.coinSpends();
    const wire: WireCoinSpend[] = cs.map((c) => ({
      coin: { parent_coin_info: w.toHex(c.coin.parentCoinInfo), puzzle_hash: w.toHex(c.coin.puzzleHash), amount: c.coin.amount.toString() },
      puzzle_reveal: w.toHex(c.puzzleReveal),
      solution: w.toHex(c.solution),
    }));
    const { signatureHex } = signDappCoinSpendsForTest(cs, pair.sk);
    return { wire, signatureHex };
  }

  // Sign the coin spends with the (own) key via the proven signer, returning the aggregated sig hex.
  function signDappCoinSpendsForTest(cs: Array<{ coin: { parentCoinInfo: Uint8Array; puzzleHash: Uint8Array; amount: bigint }; puzzleReveal: Uint8Array; solution: Uint8Array }>, sk: { sign(m: Uint8Array): unknown }): { signatureHex: string } {
    const w = chia as unknown as SimWasm;
    const wire: WireCoinSpend[] = cs.map((c) => ({
      coin: { parent_coin_info: w.toHex(c.coin.parentCoinInfo), puzzle_hash: w.toHex(c.coin.puzzleHash), amount: c.coin.amount.toString() },
      puzzle_reveal: w.toHex(c.puzzleReveal),
      solution: w.toHex(c.solution),
    }));
    // TESTNET11 additional data is the Simulator's genesis (matches signing.ts).
    return signDappCoinSpends(chia as never, wire, [sk as never], '37a90eb5185a9c4439a91ddc98bbadce7b4feba060d50116a067de66bf236615');
  }

  it('reassembles + broadcasts a dApp-signed bundle (no held key needed — the wallet relays)', async () => {
    const { wire, signatureHex } = signedBundleWire();
    let pushed: { toBytes(): Uint8Array } | null = null;
    const chain: ChainClient = {
      totalUnspent: async () => 0,
      unspentCoins: async () => [],
      pushSpendBundle: async (b) => { pushed = b as { toBytes(): Uint8Array }; return { success: true }; },
      coinConfirmed: async () => true,
      getCoinSpend: async () => null,
      coinRecords: async () => [],
    };
    // A fresh (locked) vault — broadcast needs no key; approval is the gate.
    const res = await new Vault().handle({ op: 'broadcastDappBundle', coinSpends: wire, aggregatedSignature: signatureHex }, { ...deps, chia, chain });
    expect(res.success).toBe(true);
    expect(pushed).not.toBeNull();
    expect((pushed as unknown as { toBytes(): Uint8Array }).toBytes().length).toBeGreaterThan(0);
  });

  it('surfaces a coinset push failure as PUSH_FAILED (never a silent success)', async () => {
    const { wire, signatureHex } = signedBundleWire();
    const chain: ChainClient = {
      totalUnspent: async () => 0,
      unspentCoins: async () => [],
      pushSpendBundle: async () => ({ success: false, error: 'DOUBLE_SPEND' }),
      coinConfirmed: async () => false,
      getCoinSpend: async () => null,
      coinRecords: async () => [],
    };
    const res = await new Vault().handle({ op: 'broadcastDappBundle', coinSpends: wire, aggregatedSignature: signatureHex }, { ...deps, chia, chain });
    expect(res.success).toBe(false);
    expect(res.code).toBe('PUSH_FAILED');
  });

  it('requires coinSpends + an aggregated signature', async () => {
    const chain: ChainClient = { totalUnspent: async () => 0, unspentCoins: async () => [], pushSpendBundle: async () => ({ success: true }), coinConfirmed: async () => false, getCoinSpend: async () => null, coinRecords: async () => [] };
    expect((await new Vault().handle({ op: 'broadcastDappBundle', coinSpends: [] }, { ...deps, chia, chain })).code).toBe('BAD_REQUEST');
  });
});
