import { describe, it, expect, beforeAll } from 'vitest';
import { buildKeyring, prepareXchSend, signAndBundle, type SendFlowWasm } from './sendFlow';
import { TESTNET11_AGG_SIG_ME } from './signing';
import type { ChainClient, ChainCoin, ChainSpendBundle } from './chain';
import { mnemonicToSeed } from '@/lib/keystore/bip39';
import { loadChiaWasmNode } from '@/test/chiaWasm';
import golden from '@/lib/keystore/derive.golden.json';

/**
 * The full send flow, proven authoritatively: fund a SEED-DERIVED address inside the wasm Simulator
 * (`newCoin`), then prepare → sign → the Simulator accepts the bundle. Never broadcasts to mainnet.
 */
interface TestWasm {
  fromHex(h: string): Uint8Array;
  toHex(b: Uint8Array): string;
  Address: new (puzzleHash: Uint8Array, prefix: string) => { encode(): string };
  Simulator: new () => {
    newCoin(puzzleHash: Uint8Array, amount: bigint): ChainCoin;
    newTransaction(bundle: ChainSpendBundle): void;
    createBlock(): void;
  };
}

let chia: TestWasm;
const flow = () => chia as unknown as SendFlowWasm;
beforeAll(async () => {
  chia = (await loadChiaWasmNode()) as unknown as TestWasm;
});

describe('buildKeyring', () => {
  it('derives both-scheme synthetic keys matching the golden puzzle hashes', async () => {
    const seed = await mnemonicToSeed(golden.mnemonic);
    const ring = buildKeyring(flow(), seed, { count: 3 });
    expect(ring).toHaveLength(6); // 3 unhardened + 3 hardened
    const unh = ring.slice(0, 3);
    expect(unh.map((k) => k.puzzleHashHex)).toEqual(golden.unhardened.map((g) => g.puzzleHashHex));
    // each entry's synthetic public key matches the golden synthetic pk
    expect(chia.toHex(unh[0].pk.toBytes()).replace(/^0x/i, '')).toBe(golden.unhardened[0].syntheticPkHex);
  });
});

describe('prepareXchSend → signAndBundle (Simulator-validated)', () => {
  it('builds + signs a send the Simulator accepts, funding a seed-derived address', async () => {
    const seed = await mnemonicToSeed(golden.mnemonic);
    const ring = buildKeyring(flow(), seed, { count: 2 });
    const ph0 = ring[0].puzzleHashHex;

    const sim = new chia.Simulator();
    const coin = sim.newCoin(chia.fromHex(ph0), 1_000_000_000_000n); // 1 XCH at a seed-derived address

    const recipient = new chia.Address(new Uint8Array(32).fill(9), 'xch').encode();
    const chain: ChainClient = {
      totalUnspent: async () => 0,
      unspentCoins: async (phs) => (phs.includes(ph0) ? [coin] : []),
      pushSpendBundle: async (bundle) => {
        sim.newTransaction(bundle); // validates the signed bundle; throws if invalid
        sim.createBlock();
        return { success: true };
      },
      coinConfirmed: async () => true,
    };

    const prepared = await prepareXchSend(flow(), chain, {
      seed,
      recipient,
      amount: 250_000_000_000n,
      fee: 1_000_000n,
      gapLimit: 2,
    });
    expect(prepared.summary.sent).toBe('250000000000');
    expect(prepared.summary.fee).toBe('1000000');

    const bundle = signAndBundle(flow(), prepared.coinSpends, prepared.secretKeys, TESTNET11_AGG_SIG_ME);
    const res = await chain.pushSpendBundle(bundle); // sim validates inside → no throw = consensus-valid
    expect(res.success).toBe(true);
  });
});
