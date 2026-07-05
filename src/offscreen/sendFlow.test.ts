import { describe, it, expect, beforeAll } from 'vitest';
import { buildKeyring, prepareXchSend, prepareCatSend, signAndBundle, type SendFlowWasm } from './sendFlow';
import { signCoinSpends, TESTNET11_AGG_SIG_ME, type SigningWasm } from './signing';
import type { ChainClient, ChainCoin, ChainCoinSpend, ChainSpendBundle } from './chain';
import { mnemonicToSeed } from '@/lib/keystore/bip39';
import { loadChiaWasmNode } from '@/test/chiaWasm';
import golden from '@/lib/keystore/derive.golden.json';

/**
 * The full send flow, proven authoritatively: fund a SEED-DERIVED address inside the wasm Simulator
 * (`newCoin`), then prepare → sign → the Simulator accepts the bundle. Never broadcasts to mainnet.
 */
interface SimHandle {
  newCoin(puzzleHash: Uint8Array, amount: bigint): ChainCoin;
  newTransaction(bundle: ChainSpendBundle): void;
  createBlock(): void;
  unspentCoins(puzzleHash: Uint8Array, includeHints: boolean): ChainCoin[];
  coinSpend(coinId: Uint8Array): ChainCoinSpend | undefined;
}
// The wasm surface the CAT issuance test setup uses (beyond the flow's SendFlowWasm).
interface TestWasm {
  fromHex(h: string): Uint8Array;
  toHex(b: Uint8Array): string;
  catPuzzleHash(assetId: Uint8Array, innerPh: Uint8Array): Uint8Array;
  Address: new (puzzleHash: Uint8Array, prefix: string) => { encode(): string };
  Signature: { aggregate(sigs: unknown[]): unknown };
  Simulator: new () => SimHandle;
  Clvm: new () => {
    delegatedSpend(conditions: unknown[]): unknown;
    standardSpend(pk: unknown, spend: unknown): unknown;
    coinSpends(): ChainCoinSpend[];
  };
  Spends: new (clvm: unknown, changePh: Uint8Array) => {
    addXch(coin: unknown): void;
    apply(actions: unknown[]): unknown;
    prepare(deltas: unknown): { pendingSpends(): Array<{ coin(): { coinId(): Uint8Array }; conditions(): unknown[] }>; insert(id: Uint8Array, s: unknown): void; spend(): { cats(): unknown[]; cat(id: unknown): Array<{ info: { assetId: Uint8Array } }> } };
  };
  Action: { singleIssueCat(hidden: undefined, amount: bigint): unknown };
}

let chia: TestWasm;
const flow = () => chia as unknown as SendFlowWasm;
const sig = () => chia as unknown as SigningWasm;
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
      getCoinSpend: async () => null,
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

/** A sim-backed ChainClient: reads coins/spends from the simulator; push validates via newTransaction. */
function simChain(sim: SimHandle): ChainClient {
  return {
    totalUnspent: async () => 0,
    unspentCoins: async (phs) => phs.flatMap((h) => sim.unspentCoins(chia.fromHex(h), false)),
    getCoinSpend: async (idHex) => sim.coinSpend(chia.fromHex(idHex)) ?? null,
    pushSpendBundle: async (bundle) => {
      sim.newTransaction(bundle);
      sim.createBlock();
      return { success: true };
    },
    coinConfirmed: async () => true,
  };
}

describe('prepareCatSend (Simulator-validated)', () => {
  it('issues a CAT to a seed-derived address, reconstructs it, and sends it', async () => {
    const seed = await mnemonicToSeed(golden.mnemonic);
    const ring = buildKeyring(flow(), seed, { count: 2 });
    const ph0 = ring[0].puzzleHashHex;
    const key0 = ring[0];

    const sim = new chia.Simulator();
    sim.newCoin(chia.fromHex(ph0), 5_000_000_000_000n); // XCH at a seed-derived address

    // Issue a CAT (single-issuance) minted to ph0, funded by that XCH.
    const clvm = new chia.Clvm();
    const spends = new chia.Spends(clvm, chia.fromHex(ph0));
    const xch = sim.unspentCoins(chia.fromHex(ph0), false)[0];
    spends.addXch(xch);
    const finished = spends.prepare(spends.apply([chia.Action.singleIssueCat(undefined, 1000n)]));
    for (const ps of finished.pendingSpends()) {
      finished.insert(ps.coin().coinId(), clvm.standardSpend(key0.pk, clvm.delegatedSpend(ps.conditions())));
    }
    const outputs = finished.spend();
    const assetIdHex = chia.toHex((outputs.cat(outputs.cats()[0])[0] as { info: { assetId: Uint8Array } }).info.assetId).replace(/^0x/i, '').toLowerCase();
    const issueSpends = clvm.coinSpends();
    const issueSig = signCoinSpends(sig(), issueSpends, [key0.sk], TESTNET11_AGG_SIG_ME);
    sim.newTransaction(new (chia as unknown as { SpendBundle: new (cs: unknown, s: unknown) => ChainSpendBundle }).SpendBundle(issueSpends, issueSig));
    sim.createBlock();

    // Reconstruct + send the CAT via the production flow.
    const chain = simChain(sim);
    const recipient = new chia.Address(new Uint8Array(32).fill(9), 'xch').encode();
    const prepared = await prepareCatSend(flow(), chain, { seed, assetId: assetIdHex, recipient, amount: 400n, fee: 0n, gapLimit: 2 });
    expect(prepared.summary.asset).toBe(assetIdHex);
    expect(prepared.summary.sent).toBe('400');

    const bundle = signAndBundle(flow(), prepared.coinSpends, prepared.secretKeys, TESTNET11_AGG_SIG_ME);
    const res = await chain.pushSpendBundle(bundle);
    expect(res.success).toBe(true);
  });
});
