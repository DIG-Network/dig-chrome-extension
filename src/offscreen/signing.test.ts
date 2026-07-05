import { describe, it, expect, beforeAll } from 'vitest';
import {
  requiredSignatures,
  signCoinSpends,
  MAINNET_AGG_SIG_ME,
  TESTNET11_AGG_SIG_ME,
  type SigningWasm,
  type SigCoinSpend,
  type SigSecretKey,
} from './signing';
import { loadChiaWasmNode } from '@/test/chiaWasm';

/**
 * The §5.8 signing spike, proven authoritatively against the wasm Simulator (whose genesis is
 * testnet11): both the wasm's own signer AND our from-coin-spends reconstruction produce signatures
 * the simulator accepts as consensus-valid. This is why NO foreign-spend crate is needed.
 */

// The raw wasm module (Simulator/Clvm/SpendBundle/fromHex/toHex); cast to SigningWasm at call sites.
interface TestWasm {
  fromHex(hex: string): Uint8Array;
  toHex(bytes: Uint8Array): string;
  Simulator: new () => {
    bls(amount: bigint): { sk: SigSecretKey; pk: { toBytes(): Uint8Array }; puzzleHash: Uint8Array; coin: unknown };
    spendCoins(coinSpends: SigCoinSpend[], secretKeys: SigSecretKey[]): void;
    newTransaction(bundle: unknown): void;
  };
  Clvm: new () => {
    delegatedSpend(conditions: unknown[]): unknown;
    createCoin(puzzleHash: Uint8Array, amount: bigint, memos: undefined): unknown;
    spendStandardCoin(coin: unknown, syntheticKey: { toBytes(): Uint8Array }, spend: unknown): void;
    coinSpends(): SigCoinSpend[];
  };
  SpendBundle: new (coinSpends: SigCoinSpend[], aggregatedSignature: unknown) => unknown;
}

let chia: TestWasm;
const sig = (): SigningWasm => chia as unknown as SigningWasm;
beforeAll(async () => {
  chia = (await loadChiaWasmNode()) as unknown as TestWasm;
});

/** Build a standard XCH spend for a fresh simulator coin; returns the sim, keypair, and coin spends. */
function buildStandardSpend() {
  const sim = new chia.Simulator();
  const pair = sim.bls(1000n);
  const clvm = new chia.Clvm();
  clvm.spendStandardCoin(pair.coin, pair.pk, clvm.delegatedSpend([clvm.createCoin(pair.puzzleHash, 1000n, undefined)]));
  return { sim, pair, coinSpends: clvm.coinSpends() };
}

describe('signing spike (§5.8)', () => {
  it('exposes the mainnet AGG_SIG_ME additional data', () => {
    expect(MAINNET_AGG_SIG_ME).toBe('ccd5bb71183532bff220ba46c268991a3ff07eb358e8255a65c30a2dce0e5fbb');
  });

  it('own spends sign + validate via the shipped wasm (Simulator.spendCoins)', () => {
    const { sim, pair, coinSpends } = buildStandardSpend();
    expect(() => sim.spendCoins(coinSpends, [pair.sk])).not.toThrow();
  });

  it('reconstructs the required signature (correct signer + augmented message)', () => {
    const { pair, coinSpends } = buildStandardSpend();
    const reqs = requiredSignatures(sig(), coinSpends, TESTNET11_AGG_SIG_ME);
    expect(reqs).toHaveLength(1);
    expect(reqs[0].publicKeyHex).toBe(chia.toHex(pair.pk.toBytes()).replace(/^0x/i, '').toLowerCase());
    expect(reqs[0].message).toHaveLength(32 + 32 + 32); // raw ‖ coinId ‖ additionalData
  });

  it('signCoinSpends produces a signature the Simulator accepts (from-coin-spends reconstruction)', () => {
    const { sim, pair, coinSpends } = buildStandardSpend();
    const agg = signCoinSpends(sig(), coinSpends, [pair.sk], TESTNET11_AGG_SIG_ME);
    const bundle = new chia.SpendBundle(coinSpends, agg);
    expect(() => sim.newTransaction(bundle)).not.toThrow(); // consensus-valid signature
  });

  it('throws MISSING_KEY when a required signer is not provided', () => {
    const { coinSpends } = buildStandardSpend();
    // A DISTINCT key: the simulator is deterministic, so advance past the first key to a second one.
    const s = new chia.Simulator();
    s.bls(1n);
    const other = s.bls(1n).sk;
    expect(() => signCoinSpends(sig(), coinSpends, [other], TESTNET11_AGG_SIG_ME)).toThrow(/MISSING_KEY/);
  });
});
