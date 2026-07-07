import { describe, it, expect, beforeAll } from 'vitest';
import { listDids, prepareDidCreate, prepareDidTransfer, prepareDidProfileUpdate, type DidWasm, type DidChain } from './dids';
import { buildKeyring, signAndBundle, type SendFlowWasm } from './sendFlow';
import { TESTNET11_AGG_SIG_ME } from './signing';
import type { ChainClient, ChainCoin, ChainCoinSpend, ChainSpendBundle } from './chain';
import { mnemonicToSeed, entropyToMnemonic } from '@/lib/keystore/bip39';
import { loadChiaWasmNode } from '@/test/chiaWasm';
import golden from '@/lib/keystore/derive.golden.json';

/**
 * DID engine, proven authoritatively against the wasm Simulator: a DID is created for a seed-derived
 * wallet, `listDids` finds it, `prepareDidTransfer` builds a transfer to a DIFFERENT seed-derived
 * wallet, and after the Simulator accepts the signed bundle the DID is gone from the sender and
 * discoverable by the recipient (proving both the transfer AND the recipient hint). Read-only in CI
 * (never broadcasts to mainnet); signs with the testnet11 genesis so the Simulator validates it.
 */
interface SimHandle {
  newCoin(puzzleHash: Uint8Array, amount: bigint): ChainCoin;
  newTransaction(bundle: ChainSpendBundle): void;
  createBlock(): void;
  unspentCoins(puzzleHash: Uint8Array, includeHints: boolean): ChainCoin[];
  coinSpend(coinId: Uint8Array): ChainCoinSpend | undefined;
}
interface TestWasm extends DidWasm {
  Simulator: new () => SimHandle;
}

// golden.mnemonic is the all-abandon vector; derive a DISTINCT recipient wallet from fixed entropy.
const RECIPIENT_MNEMONIC = entropyToMnemonic(new Uint8Array(32).fill(9));

let chia: TestWasm;
const asDid = () => chia as unknown as DidWasm;
const asFlow = () => chia as unknown as SendFlowWasm;

/** bech32m address for a keyring entry's inner puzzle hash (the keyring itself carries no address). */
function addressOf(puzzleHashHex: string): string {
  const AddressCtor = (chia as unknown as { Address: new (ph: Uint8Array, prefix: string) => { encode(): string } }).Address;
  return new AddressCtor(chia.fromHex(puzzleHashHex), 'xch').encode();
}

beforeAll(async () => {
  chia = (await loadChiaWasmNode()) as unknown as TestWasm;
});

/** A sim-backed chain client covering every method the DID engine calls (incl. hint discovery). */
function simChain(sim: SimHandle): DidChain {
  const base: ChainClient = {
    totalUnspent: async () => 0,
    unspentCoins: async (phs) => phs.flatMap((h) => sim.unspentCoins(chia.fromHex(h), false)),
    coinRecords: async () => [],
    getCoinSpend: async (idHex) => sim.coinSpend(chia.fromHex(idHex)) ?? null,
    pushSpendBundle: async (bundle) => {
      sim.newTransaction(bundle);
      sim.createBlock();
      return { success: true };
    },
    coinConfirmed: async () => true,
    coinsByHints: async (hints) => hints.flatMap((h) => sim.unspentCoins(chia.fromHex(h), true)),
  };
  return base;
}

describe('dids — create, list, transfer (Simulator-validated, #93)', () => {
  it('creates a DID owned by the wallet and lists it with its on-chain state', async () => {
    const seed = await mnemonicToSeed(golden.mnemonic);
    const ring = buildKeyring(asFlow(), seed, { index: 0 });
    const sim = new chia.Simulator();
    sim.newCoin(chia.fromHex(ring[0].puzzleHashHex), 1_000_000_000_000n);
    const chain = simChain(sim);

    const prepared = await prepareDidCreate(asDid(), chain, { seed, activeIndex: 0 });
    expect(prepared.launcherId).toMatch(/^[0-9a-f]{64}$/);
    expect(prepared.summary.p2PuzzleHashHex).toBe(ring[0].puzzleHashHex);

    const bundle = signAndBundle(asFlow(), prepared.coinSpends, prepared.secretKeys, TESTNET11_AGG_SIG_ME);
    expect((await chain.pushSpendBundle(bundle)).success).toBe(true);

    const dids = await listDids(asDid(), chain, { seed, activeIndex: 0 });
    expect(dids).toHaveLength(1);
    expect(dids[0].launcherId).toBe(prepared.launcherId);
    expect(dids[0].p2PuzzleHash).toBe(ring[0].puzzleHashHex);
    expect(dids[0].recoveryListHash).toBeNull();
    expect(dids[0].numVerificationsRequired).toBe('1');
  });

  it('pays a fee from the wallet when creating a DID', async () => {
    const seed = await mnemonicToSeed(golden.mnemonic);
    const ring = buildKeyring(asFlow(), seed, { index: 0 });
    const sim = new chia.Simulator();
    sim.newCoin(chia.fromHex(ring[0].puzzleHashHex), 1_000_000_000_000n);
    const chain = simChain(sim);

    const prepared = await prepareDidCreate(asDid(), chain, { seed, fee: 1_000_000n, activeIndex: 0 });
    expect(prepared.summary.fee).toBe('1000000');
    const bundle = signAndBundle(asFlow(), prepared.coinSpends, prepared.secretKeys, TESTNET11_AGG_SIG_ME);
    expect((await chain.pushSpendBundle(bundle)).success).toBe(true);
    const dids = await listDids(asDid(), chain, { seed, activeIndex: 0 });
    expect(dids.map((d) => d.launcherId)).toContain(prepared.launcherId);
  });

  it('rejects creating a DID when the wallet has no XCH to fund it', async () => {
    const seed = await mnemonicToSeed(golden.mnemonic);
    const sim = new chia.Simulator(); // no coins funded
    await expect(prepareDidCreate(asDid(), simChain(sim), { seed, activeIndex: 0 })).rejects.toThrow(/NO_XCH_COINS/);
  });

  it('returns an empty list when the wallet holds no DIDs', async () => {
    const seed = await mnemonicToSeed(golden.mnemonic);
    const ring = buildKeyring(asFlow(), seed, { index: 0 });
    const sim = new chia.Simulator();
    sim.newCoin(chia.fromHex(ring[0].puzzleHashHex), 1_000_000_000_000n);
    expect(await listDids(asDid(), simChain(sim), { seed, activeIndex: 0 })).toEqual([]);
  });

  it('transfers a DID to another wallet; it leaves the sender and lands at the recipient', async () => {
    const senderSeed = await mnemonicToSeed(golden.mnemonic);
    const recipientSeed = await mnemonicToSeed(RECIPIENT_MNEMONIC);
    const senderRing = buildKeyring(asFlow(), senderSeed, { index: 0 });
    const recipientRing = buildKeyring(asFlow(), recipientSeed, { index: 0 });
    const recipientAddr = addressOf(recipientRing[0].puzzleHashHex);

    const sim = new chia.Simulator();
    sim.newCoin(chia.fromHex(senderRing[0].puzzleHashHex), 1_000_000_000_000n);
    const chain = simChain(sim);

    const created = await prepareDidCreate(asDid(), chain, { seed: senderSeed, activeIndex: 0 });
    const createBundle = signAndBundle(asFlow(), created.coinSpends, created.secretKeys, TESTNET11_AGG_SIG_ME);
    expect((await chain.pushSpendBundle(createBundle)).success).toBe(true);

    // Sender owns it before the transfer.
    expect(await listDids(asDid(), chain, { seed: senderSeed, activeIndex: 0 })).toHaveLength(1);

    const prepared = await prepareDidTransfer(asDid(), chain, {
      seed: senderSeed,
      launcherId: created.launcherId,
      recipient: recipientAddr,
      activeIndex: 0,
    });
    expect(prepared.summary.launcherId).toBe(created.launcherId);
    expect(prepared.summary.recipientPuzzleHashHex).toBe(recipientRing[0].puzzleHashHex);

    const bundle = signAndBundle(asFlow(), prepared.coinSpends, prepared.secretKeys, TESTNET11_AGG_SIG_ME);
    const res = await chain.pushSpendBundle(bundle);
    expect(res.success).toBe(true);

    // The DID moved: gone from the sender, discoverable by the recipient (proves the transfer + hint).
    expect(await listDids(asDid(), chain, { seed: senderSeed, activeIndex: 0 })).toHaveLength(0);
    const recipientDids = await listDids(asDid(), chain, { seed: recipientSeed, activeIndex: 0 });
    expect(recipientDids).toHaveLength(1);
    expect(recipientDids[0].launcherId).toBe(created.launcherId);
    expect(recipientDids[0].p2PuzzleHash).toBe(recipientRing[0].puzzleHashHex);
  });

  it('pays a fee from the wallet when transferring a DID', async () => {
    const senderSeed = await mnemonicToSeed(golden.mnemonic);
    const recipientSeed = await mnemonicToSeed(RECIPIENT_MNEMONIC);
    const senderRing = buildKeyring(asFlow(), senderSeed, { index: 0 });
    const recipientRing = buildKeyring(asFlow(), recipientSeed, { index: 0 });

    const sim = new chia.Simulator();
    sim.newCoin(chia.fromHex(senderRing[0].puzzleHashHex), 1_000_000_000_000n);
    const chain = simChain(sim);

    const created = await prepareDidCreate(asDid(), chain, { seed: senderSeed, activeIndex: 0 });
    const createBundle = signAndBundle(asFlow(), created.coinSpends, created.secretKeys, TESTNET11_AGG_SIG_ME);
    expect((await chain.pushSpendBundle(createBundle)).success).toBe(true);

    const prepared = await prepareDidTransfer(asDid(), chain, {
      seed: senderSeed,
      launcherId: created.launcherId,
      recipient: addressOf(recipientRing[0].puzzleHashHex),
      fee: 1_000_000n,
      activeIndex: 0,
    });
    expect(prepared.summary.fee).toBe('1000000');
    const bundle = signAndBundle(asFlow(), prepared.coinSpends, prepared.secretKeys, TESTNET11_AGG_SIG_ME);
    expect((await chain.pushSpendBundle(bundle)).success).toBe(true);
    const recipientDids = await listDids(asDid(), chain, { seed: recipientSeed, activeIndex: 0 });
    expect(recipientDids.map((d) => d.launcherId)).toContain(created.launcherId);
  });

  it('throws DID_NOT_FOUND when transferring a DID the wallet does not hold', async () => {
    const seed = await mnemonicToSeed(golden.mnemonic);
    const ring = buildKeyring(asFlow(), seed, { index: 0 });
    const sim = new chia.Simulator();
    sim.newCoin(chia.fromHex(ring[0].puzzleHashHex), 1_000_000_000_000n);
    await expect(
      prepareDidTransfer(asDid(), simChain(sim), { seed, launcherId: 'ab'.repeat(32), recipient: addressOf(ring[0].puzzleHashHex), activeIndex: 0 }),
    ).rejects.toThrow(/DID_NOT_FOUND/);
  });

  it('throws HINT_LOOKUP_UNAVAILABLE when the chain cannot resolve hints', async () => {
    const seed = await mnemonicToSeed(golden.mnemonic);
    const chain = { getCoinSpend: async () => null, unspentCoins: async () => [] } as unknown as DidChain;
    await expect(listDids(asDid(), chain, { seed, activeIndex: 0 })).rejects.toThrow(/HINT_LOOKUP_UNAVAILABLE/);
  });

  it('a freshly created DID has no profile name (null) until one is set', async () => {
    const seed = await mnemonicToSeed(golden.mnemonic);
    const ring = buildKeyring(asFlow(), seed, { index: 0 });
    const sim = new chia.Simulator();
    sim.newCoin(chia.fromHex(ring[0].puzzleHashHex), 1_000_000_000_000n);
    const chain = simChain(sim);

    const created = await prepareDidCreate(asDid(), chain, { seed, activeIndex: 0 });
    const bundle = signAndBundle(asFlow(), created.coinSpends, created.secretKeys, TESTNET11_AGG_SIG_ME);
    expect((await chain.pushSpendBundle(bundle)).success).toBe(true);

    const dids = await listDids(asDid(), chain, { seed, activeIndex: 0 });
    expect(dids[0].profileName).toBeNull();
  });

  it('sets a profile name (on-chain metadata) on an owned DID; listDids reflects it', async () => {
    const seed = await mnemonicToSeed(golden.mnemonic);
    const ring = buildKeyring(asFlow(), seed, { index: 0 });
    const sim = new chia.Simulator();
    sim.newCoin(chia.fromHex(ring[0].puzzleHashHex), 1_000_000_000_000n);
    const chain = simChain(sim);

    const created = await prepareDidCreate(asDid(), chain, { seed, activeIndex: 0 });
    const createBundle = signAndBundle(asFlow(), created.coinSpends, created.secretKeys, TESTNET11_AGG_SIG_ME);
    expect((await chain.pushSpendBundle(createBundle)).success).toBe(true);

    const prepared = await prepareDidProfileUpdate(asDid(), chain, {
      seed,
      launcherId: created.launcherId,
      profileName: 'Alice the Builder',
      activeIndex: 0,
    });
    expect(prepared.summary.profileName).toBe('Alice the Builder');
    const bundle = signAndBundle(asFlow(), prepared.coinSpends, prepared.secretKeys, TESTNET11_AGG_SIG_ME);
    expect((await chain.pushSpendBundle(bundle)).success).toBe(true);

    const dids = await listDids(asDid(), chain, { seed, activeIndex: 0 });
    expect(dids).toHaveLength(1);
    expect(dids[0].launcherId).toBe(created.launcherId);
    expect(dids[0].profileName).toBe('Alice the Builder');
    // The owner + launcher id are unaffected by a metadata-only update.
    expect(dids[0].p2PuzzleHash).toBe(ring[0].puzzleHashHex);
  });

  it('pays a fee from the wallet when updating a DID profile', async () => {
    const seed = await mnemonicToSeed(golden.mnemonic);
    const ring = buildKeyring(asFlow(), seed, { index: 0 });
    const sim = new chia.Simulator();
    sim.newCoin(chia.fromHex(ring[0].puzzleHashHex), 1_000_000_000_000n);
    const chain = simChain(sim);

    const created = await prepareDidCreate(asDid(), chain, { seed, activeIndex: 0 });
    const createBundle = signAndBundle(asFlow(), created.coinSpends, created.secretKeys, TESTNET11_AGG_SIG_ME);
    expect((await chain.pushSpendBundle(createBundle)).success).toBe(true);

    const prepared = await prepareDidProfileUpdate(asDid(), chain, {
      seed,
      launcherId: created.launcherId,
      profileName: 'Bob',
      fee: 1_000_000n,
      activeIndex: 0,
    });
    expect(prepared.summary.fee).toBe('1000000');
    const bundle = signAndBundle(asFlow(), prepared.coinSpends, prepared.secretKeys, TESTNET11_AGG_SIG_ME);
    expect((await chain.pushSpendBundle(bundle)).success).toBe(true);
  });

  it('throws DID_NOT_FOUND when updating the profile of a DID the wallet does not hold', async () => {
    const seed = await mnemonicToSeed(golden.mnemonic);
    const ring = buildKeyring(asFlow(), seed, { index: 0 });
    const sim = new chia.Simulator();
    sim.newCoin(chia.fromHex(ring[0].puzzleHashHex), 1_000_000_000_000n);
    await expect(
      prepareDidProfileUpdate(asDid(), simChain(sim), { seed, launcherId: 'ab'.repeat(32), profileName: 'x', activeIndex: 0 }),
    ).rejects.toThrow(/DID_NOT_FOUND/);
  });
});
