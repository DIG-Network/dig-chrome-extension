import { describe, it, expect, beforeAll } from 'vitest';
import { Vault } from './vault';
import type { Argon2Fn } from '@/lib/keystore/digwx1';
import { isValidMnemonic, mnemonicToEntropy } from '@/lib/keystore/bip39';
import { loadChiaWasmNode } from '@/test/chiaWasm';
import type { ScanWasm } from '@/offscreen/scan';
import type { ChainClient } from '@/offscreen/chain';
import { signDappCoinSpends, type WireCoinSpend } from '@/offscreen/dappSign';
import golden from '@/lib/keystore/derive.golden.json';

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
    const res = await v.handle({ op: 'getPublicKeys', gapLimit: 3 }, { ...deps, chia });
    expect(res.success).toBe(true);
    expect(res.publicKeys).toContain(golden.unhardened[0].syntheticPkHex);
    expect(res.publicKeys).toContain(golden.hardened[0].syntheticPkHex);
  });

  it('decodeDappSpend classifies an own coin spend as self + owned signer', async () => {
    const v = await goldenWallet();
    const res = await v.handle({ op: 'decodeDappSpend', coinSpends: goldenOwnedWire(), gapLimit: 3 }, { ...deps, chia });
    expect(res.success).toBe(true);
    expect(res.dappSummary?.coinCount).toBe(1);
    expect(res.dappSummary?.inputs[0].isSelf).toBe(true);
    expect(res.dappSummary?.allInputsSelf).toBe(true);
    expect(res.dappSummary?.ownedSigners).toBe(1);
    expect(res.dappSummary?.requiredSigners).toContain(golden.unhardened[0].syntheticPkHex);
  });

  it('signDappSpend signs an own coin spend (returns a 96-byte signature)', async () => {
    const v = await goldenWallet();
    const res = await v.handle({ op: 'signDappSpend', coinSpends: goldenOwnedWire(), gapLimit: 3 }, { ...deps, chia });
    expect(res.success).toBe(true);
    expect(res.signature).toMatch(/^[0-9a-f]{192}$/);
  });

  it('signDappSpend fails MISSING_KEY on a foreign spend the wallet cannot sign', async () => {
    const v = await goldenWallet();
    const res = await v.handle({ op: 'signDappSpend', coinSpends: foreignWire(), gapLimit: 3 }, { ...deps, chia });
    expect(res.success).toBe(false);
    expect(res.code).toBe('MISSING_KEY');
  });

  it('signMessage signs and reports the signer public key', async () => {
    const v = await goldenWallet();
    const res = await v.handle({ op: 'signMessage', message: 'hello dig', gapLimit: 3 }, { ...deps, chia });
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

  it('derives the pooled receive address for the held wallet', async () => {
    const v = await unlockedZerosWallet();
    const res = await v.handle({ op: 'getReceiveAddress' }, { ...deps, chia });
    expect(res.success).toBe(true);
    expect(res.address).toBe(golden.unhardened[0].address);
  });

  it('scans XCH + CAT balances for the held wallet', async () => {
    const v = await unlockedZerosWallet();
    const res = await v.handle(
      { op: 'scanBalances', gapLimit: 5 },
      { ...deps, chia, chain: chain({ [golden.unhardened[0].puzzleHashHex]: 2_000_000_000_000 }) },
    );
    expect(res.balances?.xch).toBe(2_000_000_000_000);
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

  it('getActivity returns events (empty for an unused wallet) via the indexer', async () => {
    const v = await unlockedZerosWallet();
    const { chain } = sendChain(); // coinRecords → [] → no events
    const res = await v.handle({ op: 'getActivity' }, { ...deps, chia, chain });
    expect(res.success).toBe(true);
    expect(res.events).toEqual([]);
    expect(typeof res.cursorHeight).toBe('number');
  });

  it('getActivity is LOCKED without a held key', async () => {
    const { chain } = sendChain();
    const res = await new Vault().handle({ op: 'getActivity' }, { ...deps, chia, chain });
    expect(res.code).toBe('LOCKED');
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
  const offerXchForCat = { offered: { asset: { kind: 'xch' as const }, amount: '100000000000' }, requested: { asset: { kind: 'cat' as const, assetId: CAT }, amount: '250' } };

  it('makeOffer builds an offer1… string + two-sided summary; inspectOffer round-trips it', async () => {
    const v = await unlockedZerosWallet();
    const chain = tradeChain();
    const made = await v.handle({ op: 'makeOffer', ...offerXchForCat, gapLimit: 2 }, { ...deps, chia, chain });
    expect(made.success).toBe(true);
    expect(made.offer?.startsWith('offer1')).toBe(true);
    expect(made.offerSummary?.offered[0]).toEqual({ asset: { kind: 'xch' }, amount: '100000000000' });

    const seen = await v.handle({ op: 'inspectOffer', offerStr: made.offer! }, { ...deps, chia, chain });
    expect(seen.success).toBe(true);
    expect(seen.offerSummary?.offered[0]).toEqual({ asset: { kind: 'xch' }, amount: '100000000000' });
    expect(seen.offerSummary?.requested[0].asset).toEqual({ kind: 'cat', assetId: CAT });
    expect(seen.offerSummary?.requested[0].amount).toBe('250');
  });

  it('prepareTrade(cancel) → confirmTrade broadcasts a self-spend; a second confirm is NO_PENDING', async () => {
    const v = await unlockedZerosWallet();
    const chain = tradeChain();
    const made = await v.handle({ op: 'makeOffer', ...offerXchForCat, gapLimit: 2 }, { ...deps, chia, chain });
    const prep = await v.handle({ op: 'prepareTrade', offerStr: made.offer!, tradeKind: 'cancel', gapLimit: 2 }, { ...deps, chia, chain });
    expect(prep.success).toBe(true);
    expect(prep.pendingId).toBeTruthy();
    const conf = await v.handle({ op: 'confirmTrade', pendingId: prep.pendingId }, { ...deps, chia, chain });
    expect(conf.success).toBe(true);
    expect(conf.spentCoinId).toBeTruthy();
    const again = await v.handle({ op: 'confirmTrade', pendingId: prep.pendingId }, { ...deps, chia, chain });
    expect(again.code).toBe('NO_PENDING');
  });

  it('lock clears pending trades', async () => {
    const v = await unlockedZerosWallet();
    const chain = tradeChain();
    const made = await v.handle({ op: 'makeOffer', ...offerXchForCat, gapLimit: 2 }, { ...deps, chia, chain });
    const prep = await v.handle({ op: 'prepareTrade', offerStr: made.offer!, tradeKind: 'cancel', gapLimit: 2 }, { ...deps, chia, chain });
    v.lock();
    const conf = await v.handle({ op: 'confirmTrade', pendingId: prep.pendingId }, { ...deps, chia, chain });
    expect(conf.code).toBe('NO_PENDING');
  });

  it('guards: BAD_REQUEST / LOCKED / CHAIN_UNAVAILABLE / WASM_UNAVAILABLE / NO_PENDING', async () => {
    const v = await unlockedZerosWallet();
    const chain = tradeChain();
    expect((await v.handle({ op: 'makeOffer', gapLimit: 2 }, { ...deps, chia, chain })).code).toBe('BAD_REQUEST');
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
    const res = await v.handle({ op: 'getAssetBalance', gapLimit: 5 }, { ...deps, chia, chain: assetChain() });
    expect(res.success).toBe(true);
    expect(res.assetBalance).toEqual({ confirmed: '2500000000000', spendable: '2500000000000', spendableCoinCount: 2 });
  });

  it('getAssetBalance routes a CAT assetId to its CAT puzzle hash (asset-generic, guards #121)', async () => {
    const v = await unlockedZerosWallet();
    const res = await v.handle({ op: 'getAssetBalance', assetId: CAT, gapLimit: 5 }, { ...deps, chia, chain: assetChain() });
    expect(res.success).toBe(true);
    expect(res.assetBalance).toEqual({ confirmed: '250', spendable: '250', spendableCoinCount: 1 });
  });

  it('getAssetCoins returns the wallet\'s spendable coins (coin identity + name, unlocked)', async () => {
    const v = await unlockedZerosWallet();
    const res = await v.handle({ op: 'getAssetCoins', gapLimit: 5 }, { ...deps, chia, chain: assetChain() });
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
    const res = await v.handle({ op: 'getAssetCoins', assetId: CAT, gapLimit: 5 }, { ...deps, chia, chain: assetChain() });
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
