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

describe('buildKeyring (single active index, #165)', () => {
  it('derives EXACTLY the both-scheme pair for the requested index — no multi-index sweep', async () => {
    const seed = await mnemonicToSeed(golden.mnemonic);
    const ring = buildKeyring(flow(), seed, { index: 0 });
    expect(ring).toHaveLength(2); // unhardened + hardened at index 0 only
    expect(ring[0].puzzleHashHex).toBe(golden.unhardened[0].puzzleHashHex);
    expect(ring[1].puzzleHashHex).toBe(golden.hardened[0].puzzleHashHex);
    // each entry's synthetic public key matches the golden synthetic pk
    expect(chia.toHex(ring[0].pk.toBytes()).replace(/^0x/i, '')).toBe(golden.unhardened[0].syntheticPkHex);
  });

  it('a different index derives that index only, matching its own golden vector', async () => {
    const seed = await mnemonicToSeed(golden.mnemonic);
    const ring = buildKeyring(flow(), seed, { index: 2 });
    expect(ring).toHaveLength(2);
    expect(ring[0].puzzleHashHex).toBe(golden.unhardened[2].puzzleHashHex);
    expect(ring[1].puzzleHashHex).toBe(golden.hardened[2].puzzleHashHex);
  });
});

describe('prepareXchSend → signAndBundle (Simulator-validated)', () => {
  it('builds + signs a send the Simulator accepts, funding a seed-derived address', async () => {
    const seed = await mnemonicToSeed(golden.mnemonic);
    const ring = buildKeyring(flow(), seed, { index: 0 });
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
      coinRecords: async () => [],
    };

    const prepared = await prepareXchSend(flow(), chain, {
      seed,
      recipient,
      amount: 250_000_000_000n,
      fee: 1_000_000n,
      activeIndex: 0,
    });
    expect(prepared.summary.sent).toBe('250000000000');
    expect(prepared.summary.fee).toBe('1000000');

    const bundle = signAndBundle(flow(), prepared.coinSpends, prepared.secretKeys, TESTNET11_AGG_SIG_ME);
    const res = await chain.pushSpendBundle(bundle); // sim validates inside → no throw = consensus-valid
    expect(res.success).toBe(true);
  });
});

describe('prepareXchSend coin selection (#91)', () => {
  it('uses ONLY the hand-picked coins when selectedCoinIds is given', async () => {
    const seed = await mnemonicToSeed(golden.mnemonic);
    const ring = buildKeyring(flow(), seed, { index: 0 });
    const ph0 = ring[0].puzzleHashHex;
    const sim = new chia.Simulator();
    const coinA = sim.newCoin(chia.fromHex(ph0), 1_000_000_000_000n);
    const coinB = sim.newCoin(chia.fromHex(ph0), 2_000_000_000_000n);
    const idA = chia.toHex(coinA.coinId()).replace(/^0x/i, '').toLowerCase();
    const idB = chia.toHex(coinB.coinId()).replace(/^0x/i, '').toLowerCase();
    const chain = simChain(sim);
    const recipient = new chia.Address(new Uint8Array(32).fill(9), 'xch').encode();

    const prepared = await prepareXchSend(flow(), chain, {
      seed,
      recipient,
      amount: 100_000_000_000n,
      fee: 0n,
      activeIndex: 0,
      selectedCoinIds: [idA],
    });
    const inputIds = prepared.coinSpends.map((cs) => chia.toHex(cs.coin.coinId()).replace(/^0x/i, '').toLowerCase());
    expect(inputIds).toContain(idA);
    expect(inputIds).not.toContain(idB); // coin B was NOT selected → never spent
  });

  it('#105 — includes an optional memo, decoded back from the built spend', async () => {
    const seed = await mnemonicToSeed(golden.mnemonic);
    const ring = buildKeyring(flow(), seed, { index: 0 });
    const ph0 = ring[0].puzzleHashHex;
    const sim = new chia.Simulator();
    sim.newCoin(chia.fromHex(ph0), 1_000_000_000_000n);
    const recipient = new chia.Address(new Uint8Array(32).fill(9), 'xch').encode();

    const prepared = await prepareXchSend(flow(), simChain(sim), {
      seed,
      recipient,
      amount: 100_000_000_000n,
      fee: 0n,
      activeIndex: 0,
      memo: 'thanks!',
    });
    expect(prepared.summary.memoText).toBe('thanks!');
  });

  it('omits memoText when no memo is given', async () => {
    const seed = await mnemonicToSeed(golden.mnemonic);
    const ring = buildKeyring(flow(), seed, { index: 0 });
    const ph0 = ring[0].puzzleHashHex;
    const sim = new chia.Simulator();
    sim.newCoin(chia.fromHex(ph0), 1_000_000_000_000n);
    const recipient = new chia.Address(new Uint8Array(32).fill(9), 'xch').encode();
    const prepared = await prepareXchSend(flow(), simChain(sim), { seed, recipient, amount: 1000n, fee: 0n, activeIndex: 0 });
    expect(prepared.summary.memoText).toBeUndefined();
  });

  it('throws when the selection matches no owned coin', async () => {
    const seed = await mnemonicToSeed(golden.mnemonic);
    const ring = buildKeyring(flow(), seed, { index: 0 });
    const sim = new chia.Simulator();
    sim.newCoin(chia.fromHex(ring[0].puzzleHashHex), 1_000_000_000_000n);
    const recipient = new chia.Address(new Uint8Array(32).fill(9), 'xch').encode();
    await expect(
      prepareXchSend(flow(), simChain(sim), { seed, recipient, amount: 1000n, fee: 0n, activeIndex: 0, selectedCoinIds: ['ab'.repeat(32)] }),
    ).rejects.toThrow(/NO_SELECTED_COINS/);
  });
});

/** A sim-backed ChainClient: reads coins/spends from the simulator; push validates via newTransaction. */
function simChain(sim: SimHandle): ChainClient {
  return {
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
  };
}

describe('prepareCatSend (Simulator-validated)', () => {
  it('issues a CAT to a seed-derived address, reconstructs it, and sends it', async () => {
    const seed = await mnemonicToSeed(golden.mnemonic);
    const ring = buildKeyring(flow(), seed, { index: 0 });
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
    const prepared = await prepareCatSend(flow(), chain, { seed, assetId: assetIdHex, recipient, amount: 400n, fee: 0n, activeIndex: 0 });
    expect(prepared.summary.asset).toBe(assetIdHex);
    expect(prepared.summary.sent).toBe('400');

    const bundle = signAndBundle(flow(), prepared.coinSpends, prepared.secretKeys, TESTNET11_AGG_SIG_ME);
    const res = await chain.pushSpendBundle(bundle);
    expect(res.success).toBe(true);
  });

  it('#105 — forwards an optional memo onto the CAT send', async () => {
    const seed = await mnemonicToSeed(golden.mnemonic);
    const ring = buildKeyring(flow(), seed, { index: 0 });
    const ph0 = ring[0].puzzleHashHex;
    const key0 = ring[0];

    const sim = new chia.Simulator();
    sim.newCoin(chia.fromHex(ph0), 5_000_000_000_000n);

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

    const chain = simChain(sim);
    const recipient = new chia.Address(new Uint8Array(32).fill(9), 'xch').encode();
    const prepared = await prepareCatSend(flow(), chain, { seed, assetId: assetIdHex, recipient, amount: 400n, fee: 0n, activeIndex: 0, memo: 'for the CAT' });
    expect(prepared.summary.memoText).toBe('for the CAT');

    const bundle = signAndBundle(flow(), prepared.coinSpends, prepared.secretKeys, TESTNET11_AGG_SIG_ME);
    const res = await chain.pushSpendBundle(bundle);
    expect(res.success).toBe(true);
  });
});
