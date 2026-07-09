import { describe, it, expect, beforeAll } from 'vitest';
import { prepareOptionMint, prepareOptionExercise, type OptionWasm, type OptionChain } from './optionContracts';
import { buildKeyring, signAndBundle, type SendFlowWasm } from './sendFlow';
import { TESTNET11_AGG_SIG_ME } from './signing';
import type { ChainClient, ChainCoin, ChainCoinSpend, ChainSpendBundle } from './chain';
import { mnemonicToSeed } from '@/lib/keystore/bip39';
import { loadChiaWasmNode } from '@/test/chiaWasm';
import golden from '@/lib/keystore/derive.golden.json';

/**
 * Option-contract engine (#104), proven authoritatively against the wasm Simulator: mint an
 * XCH-denominated option to a seed-derived wallet, then exercise it as the SAME wallet (self-mint,
 * self-exercise — the MVP round trip, see the module doc for why a third party can't exercise
 * without the terms being published out-of-band). Uses REALISTIC (non-toy) amounts to prove coin
 * conservation genuinely balances — the upstream reference test this module mirrors uses a 1-mojo
 * toy strike, which would hide a conservation bug a real-sized strike would expose. Never broadcasts
 * to mainnet in CI.
 */
interface SimHandle {
  newCoin(puzzleHash: Uint8Array, amount: bigint): ChainCoin;
  newTransaction(bundle: ChainSpendBundle): void;
  createBlock(): void;
  unspentCoins(puzzleHash: Uint8Array, includeHints: boolean): ChainCoin[];
  coinSpend(coinId: Uint8Array): ChainCoinSpend | undefined;
}
interface TestWasm extends OptionWasm {
  Simulator: new () => SimHandle;
  SpendBundle: new (coinSpends: unknown[], signature: unknown) => ChainSpendBundle;
}

let chia: TestWasm;
const asOption = () => chia as unknown as OptionWasm;
const asFlow = () => chia as unknown as SendFlowWasm;

beforeAll(async () => {
  chia = (await loadChiaWasmNode()) as unknown as TestWasm;
});

/** A sim-backed chain client covering every method the option engine calls. */
function simChain(sim: SimHandle): OptionChain {
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

const ONE_XCH = 1_000_000_000_000n;
const FAR_FUTURE = 9_999_999_999n;

describe('optionContracts — mint + exercise (Simulator-validated, #104)', () => {
  async function fundedWriter() {
    const seed = await mnemonicToSeed(golden.mnemonic);
    const ring = buildKeyring(asFlow(), seed, { index: 0 });
    const sim = new chia.Simulator();
    sim.newCoin(chia.fromHex(ring[0].puzzleHashHex), 5n * ONE_XCH);
    return { seed, ring, sim, chain: simChain(sim) };
  }

  it('mints an XCH-denominated option (realistic amounts) and broadcasts it', async () => {
    const { seed, chain } = await fundedWriter();
    const prepared = await prepareOptionMint(asOption(), chain, {
      seed,
      underlyingAmount: ONE_XCH,
      strikeAmount: ONE_XCH / 2n,
      expirationSeconds: FAR_FUTURE,
      activeIndex: 0,
    });
    expect(prepared.record.launcherId).toMatch(/^[0-9a-f]{64}$/);
    expect(prepared.record.underlyingAmount).toBe(ONE_XCH.toString());
    expect(prepared.record.strikeAmount).toBe((ONE_XCH / 2n).toString());

    const bundle = signAndBundle(asFlow(), prepared.coinSpends, prepared.secretKeys, TESTNET11_AGG_SIG_ME);
    const res = await chain.pushSpendBundle(bundle);
    expect(res.success).toBe(true);
  });

  it('mints then exercises (self-mint, self-exercise) — the strike lands with the creator, the underlying with the holder', async () => {
    const { seed, chain } = await fundedWriter();
    const minted = await prepareOptionMint(asOption(), chain, {
      seed,
      underlyingAmount: ONE_XCH,
      strikeAmount: ONE_XCH / 2n,
      expirationSeconds: FAR_FUTURE,
      activeIndex: 0,
    });
    const mintBundle = signAndBundle(asFlow(), minted.coinSpends, minted.secretKeys, TESTNET11_AGG_SIG_ME);
    expect((await chain.pushSpendBundle(mintBundle)).success).toBe(true);

    const exercised = await prepareOptionExercise(asOption(), chain, {
      seed,
      record: minted.record,
      activeIndex: 0,
      nowSeconds: 1_700_000_000n,
    });
    expect(exercised.summary.launcherId).toBe(minted.record.launcherId);
    const exerciseBundle = signAndBundle(asFlow(), exercised.coinSpends, exercised.secretKeys, TESTNET11_AGG_SIG_ME);
    const res = await chain.pushSpendBundle(exerciseBundle);
    expect(res.success).toBe(true);

    // The option's live coin is gone (melted) — a second exercise attempt finds nothing.
    await expect(
      prepareOptionExercise(asOption(), chain, { seed, record: minted.record, activeIndex: 0, nowSeconds: 1_700_000_000n }),
    ).rejects.toThrow(/OPTION_NOT_FOUND/);
  });

  it('throws EXPIRED past the recorded expiration', async () => {
    const { seed, chain } = await fundedWriter();
    const minted = await prepareOptionMint(asOption(), chain, {
      seed,
      underlyingAmount: ONE_XCH,
      strikeAmount: ONE_XCH / 2n,
      expirationSeconds: 1_700_000_000n,
      activeIndex: 0,
    });
    const bundle = signAndBundle(asFlow(), minted.coinSpends, minted.secretKeys, TESTNET11_AGG_SIG_ME);
    expect((await chain.pushSpendBundle(bundle)).success).toBe(true);

    await expect(
      prepareOptionExercise(asOption(), chain, { seed, record: minted.record, activeIndex: 0, nowSeconds: 1_800_000_000n }),
    ).rejects.toThrow(/EXPIRED/);
  });

  it('throws BAD_REQUEST for non-positive underlying/strike/expiration', async () => {
    const { seed, chain } = await fundedWriter();
    await expect(prepareOptionMint(asOption(), chain, { seed, underlyingAmount: 0n, strikeAmount: 1n, expirationSeconds: FAR_FUTURE, activeIndex: 0 })).rejects.toThrow(/BAD_REQUEST/);
    await expect(prepareOptionMint(asOption(), chain, { seed, underlyingAmount: 1n, strikeAmount: 0n, expirationSeconds: FAR_FUTURE, activeIndex: 0 })).rejects.toThrow(/BAD_REQUEST/);
    await expect(prepareOptionMint(asOption(), chain, { seed, underlyingAmount: 1n, strikeAmount: 1n, expirationSeconds: 0n, activeIndex: 0 })).rejects.toThrow(/BAD_REQUEST/);
  });

  it('throws NO_XCH_COINS when the wallet has no XCH to fund the mint', async () => {
    const seed = await mnemonicToSeed(golden.mnemonic);
    const chain: OptionChain = { totalUnspent: async () => 0, unspentCoins: async () => [], coinRecords: async () => [], getCoinSpend: async () => null, pushSpendBundle: async () => ({ success: true }), coinConfirmed: async () => true };
    await expect(prepareOptionMint(asOption(), chain, { seed, underlyingAmount: ONE_XCH, strikeAmount: 1n, expirationSeconds: FAR_FUTURE, activeIndex: 0 })).rejects.toThrow(/NO_XCH_COINS/);
  });

  it('pays a fee from the wallet when minting and exercising', async () => {
    const { seed, chain } = await fundedWriter();
    const minted = await prepareOptionMint(asOption(), chain, {
      seed,
      underlyingAmount: ONE_XCH,
      strikeAmount: ONE_XCH / 2n,
      expirationSeconds: FAR_FUTURE,
      fee: 1_000_000n,
      activeIndex: 0,
    });
    expect(minted.summary.fee).toBe('1000000');
    const mintBundle = signAndBundle(asFlow(), minted.coinSpends, minted.secretKeys, TESTNET11_AGG_SIG_ME);
    expect((await chain.pushSpendBundle(mintBundle)).success).toBe(true);

    const exercised = await prepareOptionExercise(asOption(), chain, { seed, record: minted.record, fee: 1_000_000n, activeIndex: 0, nowSeconds: 1_700_000_000n });
    expect(exercised.summary.fee).toBe('1000000');
    const exerciseBundle = signAndBundle(asFlow(), exercised.coinSpends, exercised.secretKeys, TESTNET11_AGG_SIG_ME);
    expect((await chain.pushSpendBundle(exerciseBundle)).success).toBe(true);
  });
});
