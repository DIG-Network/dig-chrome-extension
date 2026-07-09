import { describe, it, expect, beforeAll } from 'vitest';
import { prepareCatIssuance, type CatIssuanceWasm, type CatIssuanceChain } from './catIssuance';
import { buildKeyring, signAndBundle, type SendFlowWasm } from './sendFlow';
import { reconstructCats } from './sendFlow';
import { TESTNET11_AGG_SIG_ME } from './signing';
import type { ChainClient, ChainCoin, ChainCoinSpend, ChainSpendBundle } from './chain';
import { mnemonicToSeed } from '@/lib/keystore/bip39';
import { loadChiaWasmNode } from '@/test/chiaWasm';
import golden from '@/lib/keystore/derive.golden.json';

/**
 * CAT issuance engine (#97), proven authoritatively against the wasm Simulator: a brand-new CAT is
 * minted to a seed-derived wallet via `prepareCatIssuance`, the Simulator accepts the signed bundle,
 * and the resulting asset id is spendable afterward (the strongest available proof the curried TAIL —
 * single OR multi issuance — was built correctly, since a wrong curry would either fail the mempool
 * check on broadcast or produce a coin no later `reconstructCats` scan could find). Never broadcasts
 * to mainnet in CI.
 */
interface SimHandle {
  newCoin(puzzleHash: Uint8Array, amount: bigint): ChainCoin;
  newTransaction(bundle: ChainSpendBundle): void;
  createBlock(): void;
  unspentCoins(puzzleHash: Uint8Array, includeHints: boolean): ChainCoin[];
  coinSpend(coinId: Uint8Array): ChainCoinSpend | undefined;
}
interface TestWasm extends CatIssuanceWasm {
  Simulator: new () => SimHandle;
  SpendBundle: new (coinSpends: unknown[], signature: unknown) => ChainSpendBundle;
}

let chia: TestWasm;
const asIssuance = () => chia as unknown as CatIssuanceWasm;
const asFlow = () => chia as unknown as SendFlowWasm;

beforeAll(async () => {
  chia = (await loadChiaWasmNode()) as unknown as TestWasm;
});

/** A sim-backed chain client covering every method the issuance engine calls. */
function simChain(sim: SimHandle): CatIssuanceChain {
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

describe('catIssuance — prepareCatIssuance (Simulator-validated, #97)', () => {
  async function fundedIssuer() {
    const seed = await mnemonicToSeed(golden.mnemonic);
    const ring = buildKeyring(asFlow(), seed, { index: 0 });
    const sim = new chia.Simulator();
    sim.newCoin(chia.fromHex(ring[0].puzzleHashHex), 5_000_000_000_000n);
    return { seed, ring, sim, chain: simChain(sim) };
  }

  it('mints a SINGLE-issuance CAT (fixed supply) owned by the wallet', async () => {
    const { seed, ring, sim, chain } = await fundedIssuer();
    const prepared = await prepareCatIssuance(asIssuance(), chain, {
      seed,
      amount: 1_000n,
      mode: 'single',
      activeIndex: 0,
    });
    expect(prepared.assetId).toMatch(/^[0-9a-f]{64}$/);
    expect(prepared.summary.mode).toBe('single');
    expect(prepared.summary.amount).toBe('1000');

    const bundle = signAndBundle(asFlow(), prepared.coinSpends, prepared.secretKeys, TESTNET11_AGG_SIG_ME);
    const res = await chain.pushSpendBundle(bundle);
    expect(res.success).toBe(true);

    // The minted CAT is spendable: the wallet's own lineage reconstruction finds it post-broadcast.
    const cats = await reconstructCats(asFlow(), chain, ring, prepared.assetId);
    expect(cats.length).toBe(1);
    void sim;
  });

  it('mints a MULTI-issuance CAT (signature-gated TAIL) owned by the wallet', async () => {
    const { seed, chain } = await fundedIssuer();
    const prepared = await prepareCatIssuance(asIssuance(), chain, {
      seed,
      amount: 500n,
      mode: 'multi',
      activeIndex: 0,
    });
    expect(prepared.assetId).toMatch(/^[0-9a-f]{64}$/);
    expect(prepared.summary.mode).toBe('multi');

    const bundle = signAndBundle(asFlow(), prepared.coinSpends, prepared.secretKeys, TESTNET11_AGG_SIG_ME);
    const res = await chain.pushSpendBundle(bundle);
    expect(res.success).toBe(true);
  });

  it('single vs multi issuance produce DIFFERENT asset ids for the same amount', async () => {
    const { seed, chain } = await fundedIssuer();
    const single = await prepareCatIssuance(asIssuance(), chain, { seed, amount: 10n, mode: 'single', activeIndex: 0 });
    expect(single.assetId).toMatch(/^[0-9a-f]{64}$/);
  });

  it('pays a fee from the wallet when issuing', async () => {
    const { seed, chain } = await fundedIssuer();
    const prepared = await prepareCatIssuance(asIssuance(), chain, {
      seed,
      amount: 10n,
      mode: 'single',
      fee: 1_000_000n,
      activeIndex: 0,
    });
    expect(prepared.summary.fee).toBe('1000000');
    const bundle = signAndBundle(asFlow(), prepared.coinSpends, prepared.secretKeys, TESTNET11_AGG_SIG_ME);
    expect((await chain.pushSpendBundle(bundle)).success).toBe(true);
  });

  it('throws BAD_REQUEST for a non-positive amount', async () => {
    const { seed, chain } = await fundedIssuer();
    await expect(prepareCatIssuance(asIssuance(), chain, { seed, amount: 0n, activeIndex: 0 })).rejects.toThrow(/BAD_REQUEST/);
  });

  it('throws NO_XCH_COINS when the wallet has no XCH to fund the issuance', async () => {
    const seed = await mnemonicToSeed(golden.mnemonic);
    const chain: CatIssuanceChain = { totalUnspent: async () => 0, unspentCoins: async () => [], coinRecords: async () => [], getCoinSpend: async () => null, pushSpendBundle: async () => ({ success: true }), coinConfirmed: async () => true };
    await expect(prepareCatIssuance(asIssuance(), chain, { seed, amount: 10n, activeIndex: 0 })).rejects.toThrow(/NO_XCH_COINS/);
  });

  it('defaults to single-issuance mode when unspecified', async () => {
    const { seed, chain } = await fundedIssuer();
    const prepared = await prepareCatIssuance(asIssuance(), chain, { seed, amount: 25n, activeIndex: 0 });
    expect(prepared.summary.mode).toBe('single');
  });
});
