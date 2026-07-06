import { describe, it, expect, beforeAll } from 'vitest';
import { listCoins, prepareSplit, prepareCombine, decodeCoinOpSummary, type CoinsWasm } from './coins';
import { buildXchSend, type SendWasm } from './send';
import { buildKeyring, type SendFlowWasm } from './sendFlow';
import { issueCatTo, type CatSimWasm, type SimHandle } from '@/test/catSim';
import { signCoinSpends, TESTNET11_AGG_SIG_ME, type SigningWasm } from './signing';
import type { ChainClient, ChainCoin, ChainCoinRecord } from './chain';
import { mnemonicToSeed } from '@/lib/keystore/bip39';
import { loadChiaWasmNode } from '@/test/chiaWasm';
import golden from '@/lib/keystore/derive.golden.json';

/**
 * Coin control (#91) — list / split / combine proven consensus-valid against the wasm Simulator
 * through the REAL driver path (never a mock). Split/combine are self-sends: assert output coins,
 * amounts, and asset (XCH stays XCH; a CAT stays that CAT, guarding the #121 asset-drop class), and
 * that every output lands on a wallet-owned puzzle hash. Never broadcasts a real spend.
 */

interface TestWasm extends CatSimWasm {
  Simulator: new () => SimHandle & {
    newCoin(ph: Uint8Array, amount: bigint): ChainCoin;
    bls(amount: bigint): { sk: never; pk: { toBytes(): Uint8Array }; puzzleHash: Uint8Array; coin: unknown };
  };
}

let chia: TestWasm;
const asCoins = () => chia as unknown as CoinsWasm;
const asFlow = () => chia as unknown as SendFlowWasm;
const asSig = () => chia as unknown as SigningWasm;
beforeAll(async () => {
  chia = (await loadChiaWasmNode()) as unknown as TestWasm;
});

const hx = (b: Uint8Array): string => chia.toHex(b).replace(/^0x/i, '').toLowerCase();

/** A sim-backed chain client covering coin listing (with a synthetic confirmed height) + lineage. */
function simChain(sim: SimHandle): ChainClient {
  const records = (phs: string[]): ChainCoinRecord[] =>
    phs.flatMap((h) =>
      sim.unspentCoins(chia.fromHex(h), false).map((coin) => ({
        coin: coin as ChainCoin & { amount: bigint },
        spent: false,
        confirmedHeight: 42,
        spentHeight: 0,
        timestamp: 0,
      })),
    );
  return {
    totalUnspent: async () => 0,
    unspentCoins: async (phs) => phs.flatMap((h) => sim.unspentCoins(chia.fromHex(h), false)),
    coinRecords: async (phs) => records(phs),
    getCoinSpend: async (idHex) => sim.coinSpend(chia.fromHex(idHex)) ?? null,
    pushSpendBundle: async (bundle) => {
      sim.newTransaction(bundle);
      sim.createBlock();
      return { success: true };
    },
    coinConfirmed: async () => true,
    coinsByHints: async (hints) => hints.flatMap((h) => sim.unspentCoins(chia.fromHex(h), true)),
  };
}

/** Sign a prepared coin op with the testnet11 (sim genesis) domain and push it — the Simulator validates it. */
function pushPrepared(sim: SimHandle, prepared: { coinSpends: never[]; secretKeys: never[] }): void {
  const sig = signCoinSpends(asSig(), prepared.coinSpends, prepared.secretKeys, TESTNET11_AGG_SIG_ME);
  sim.newTransaction(new chia.SpendBundle(prepared.coinSpends, sig));
  sim.createBlock();
}

describe('listCoins', () => {
  it('lists the wallet XCH coins with id, amount, and confirmed height (routed by asset)', async () => {
    const seed = await mnemonicToSeed(golden.mnemonic);
    const ring = buildKeyring(asFlow(), seed, { count: 4 });
    const sim = new chia.Simulator();
    sim.newCoin(chia.fromHex(ring[0].puzzleHashHex), 1000n);
    sim.newCoin(chia.fromHex(ring[1].puzzleHashHex), 2000n);

    const coins = await listCoins(asCoins(), simChain(sim), { seed, gapLimit: 4 });
    expect(coins).toHaveLength(2);
    expect(coins.map((c) => c.amount).sort()).toEqual(['1000', '2000']);
    expect(coins.every((c) => c.confirmedHeight === 42)).toBe(true);
    expect(coins.every((c) => /^[0-9a-f]{64}$/.test(c.coinId))).toBe(true);
  });

  it('lists a CAT asset\'s coins, not native XCH (#121 routing)', async () => {
    const seed = await mnemonicToSeed(golden.mnemonic);
    const ring = buildKeyring(asFlow(), seed, { count: 2 });
    const sim = new chia.Simulator();
    sim.newCoin(chia.fromHex(ring[0].puzzleHashHex), 5_000_000_000_000n);
    const tail = issueCatTo(chia, asSig(), sim, ring, 1000n);

    const catCoins = await listCoins(asCoins(), simChain(sim), { seed, assetId: tail, gapLimit: 2 });
    expect(catCoins).toHaveLength(1);
    expect(catCoins[0].amount).toBe('1000'); // the CAT amount, not the XCH change

    const xchCoins = await listCoins(asCoins(), simChain(sim), { seed, gapLimit: 2 });
    // XCH listing must NOT include the CAT coin.
    expect(xchCoins.some((c) => c.coinId === catCoins[0].coinId)).toBe(false);
  });
});

describe('prepareSplit', () => {
  it('splits one XCH coin into N distinct self coins the Simulator accepts', async () => {
    const seed = await mnemonicToSeed(golden.mnemonic);
    const ring = buildKeyring(asFlow(), seed, { count: 8 });
    const sim = new chia.Simulator();
    sim.newCoin(chia.fromHex(ring[0].puzzleHashHex), 10_000n);
    const coinId = hx((sim.unspentCoins(chia.fromHex(ring[0].puzzleHashHex), false)[0] as ChainCoin).coinId());

    const prepared = await prepareSplit(asCoins(), simChain(sim), { seed, coinIds: [coinId], outputs: 3, fee: 0n, gapLimit: 8 });
    expect(prepared.coinOpSummary.kind).toBe('split');
    expect(prepared.coinOpSummary.asset).toBe('XCH');
    expect(prepared.coinOpSummary.inputCoinCount).toBe(1);
    expect(prepared.coinOpSummary.outputCoinCount).toBe(3);
    expect(prepared.coinOpSummary.total).toBe('10000');

    pushPrepared(sim, prepared as never);
    const after = await listCoins(asCoins(), simChain(sim), { seed, gapLimit: 8 });
    expect(after).toHaveLength(3);
    expect(after.reduce((s, c) => s + BigInt(c.amount), 0n)).toBe(10_000n);
  });

  it('splits a CAT coin into N CAT coins (asset preserved, never XCH — #121)', async () => {
    const seed = await mnemonicToSeed(golden.mnemonic);
    const ring = buildKeyring(asFlow(), seed, { count: 8 });
    const sim = new chia.Simulator();
    sim.newCoin(chia.fromHex(ring[0].puzzleHashHex), 5_000_000_000_000n);
    const tail = issueCatTo(chia, asSig(), sim, ring, 1000n);
    const catId = (await listCoins(asCoins(), simChain(sim), { seed, assetId: tail, gapLimit: 8 }))[0].coinId;

    const prepared = await prepareSplit(asCoins(), simChain(sim), { seed, assetId: tail, coinIds: [catId], outputs: 4, fee: 0n, gapLimit: 8 });
    expect(prepared.coinOpSummary.asset).toBe(tail);
    expect(prepared.coinOpSummary.asset).not.toBe('XCH');
    expect(prepared.coinOpSummary.outputCoinCount).toBe(4);

    pushPrepared(sim, prepared as never);
    const after = await listCoins(asCoins(), simChain(sim), { seed, assetId: tail, gapLimit: 8 });
    expect(after).toHaveLength(4);
    expect(after.reduce((s, c) => s + BigInt(c.amount), 0n)).toBe(1000n);
  });

  it('rejects a split that would create zero-amount pieces', async () => {
    const seed = await mnemonicToSeed(golden.mnemonic);
    const ring = buildKeyring(asFlow(), seed, { count: 4 });
    const sim = new chia.Simulator();
    sim.newCoin(chia.fromHex(ring[0].puzzleHashHex), 2n);
    const coinId = hx((sim.unspentCoins(chia.fromHex(ring[0].puzzleHashHex), false)[0] as ChainCoin).coinId());
    await expect(prepareSplit(asCoins(), simChain(sim), { seed, coinIds: [coinId], outputs: 4, fee: 0n, gapLimit: 4 })).rejects.toThrow(/SPLIT_TOO_SMALL/);
  });
});

describe('prepareCombine', () => {
  it('combines N XCH coins into one self coin the Simulator accepts', async () => {
    const seed = await mnemonicToSeed(golden.mnemonic);
    const ring = buildKeyring(asFlow(), seed, { count: 4 });
    const sim = new chia.Simulator();
    sim.newCoin(chia.fromHex(ring[0].puzzleHashHex), 1000n);
    sim.newCoin(chia.fromHex(ring[1].puzzleHashHex), 2000n);
    sim.newCoin(chia.fromHex(ring[2].puzzleHashHex), 3000n);
    const ids = (await listCoins(asCoins(), simChain(sim), { seed, gapLimit: 4 })).map((c) => c.coinId);

    const prepared = await prepareCombine(asCoins(), simChain(sim), { seed, coinIds: ids, fee: 0n, gapLimit: 4 });
    expect(prepared.coinOpSummary.kind).toBe('combine');
    expect(prepared.coinOpSummary.inputCoinCount).toBe(3);
    expect(prepared.coinOpSummary.outputCoinCount).toBe(1);
    expect(prepared.coinOpSummary.total).toBe('6000');

    pushPrepared(sim, prepared as never);
    const after = await listCoins(asCoins(), simChain(sim), { seed, gapLimit: 4 });
    expect(after).toHaveLength(1);
    expect(after[0].amount).toBe('6000');
  });

  it('requires at least two coins to combine', async () => {
    const seed = await mnemonicToSeed(golden.mnemonic);
    const ring = buildKeyring(asFlow(), seed, { count: 2 });
    const sim = new chia.Simulator();
    sim.newCoin(chia.fromHex(ring[0].puzzleHashHex), 1000n);
    const id = (await listCoins(asCoins(), simChain(sim), { seed, gapLimit: 2 }))[0].coinId;
    await expect(prepareCombine(asCoins(), simChain(sim), { seed, coinIds: [id], fee: 0n, gapLimit: 2 })).rejects.toThrow(/NEED_TWO_COINS/);
  });

  it('combines CAT coins into one CAT coin (asset preserved — #121)', async () => {
    const seed = await mnemonicToSeed(golden.mnemonic);
    const ring = buildKeyring(asFlow(), seed, { count: 8 });
    const sim = new chia.Simulator();
    sim.newCoin(chia.fromHex(ring[0].puzzleHashHex), 5_000_000_000_000n);
    const tail = issueCatTo(chia, asSig(), sim, ring, 1000n);
    // First split into two CAT coins, then combine them back into one.
    const catId = (await listCoins(asCoins(), simChain(sim), { seed, assetId: tail, gapLimit: 8 }))[0].coinId;
    pushPrepared(sim, (await prepareSplit(asCoins(), simChain(sim), { seed, assetId: tail, coinIds: [catId], outputs: 2, fee: 0n, gapLimit: 8 })) as never);
    const two = await listCoins(asCoins(), simChain(sim), { seed, assetId: tail, gapLimit: 8 });
    expect(two).toHaveLength(2);

    const prepared = await prepareCombine(asCoins(), simChain(sim), { seed, assetId: tail, coinIds: two.map((c) => c.coinId), fee: 0n, gapLimit: 8 });
    expect(prepared.coinOpSummary.asset).toBe(tail);
    expect(prepared.coinOpSummary.outputCoinCount).toBe(1);
    pushPrepared(sim, prepared as never);
    const after = await listCoins(asCoins(), simChain(sim), { seed, assetId: tail, gapLimit: 8 });
    expect(after).toHaveLength(1);
    expect(after[0].amount).toBe('1000');
  });
});

describe('decodeCoinOpSummary — self-send invariant', () => {
  it('throws SELF_SEND_VIOLATION when a built spend pays a non-wallet address', () => {
    const sim = new chia.Simulator();
    const pair = sim.bls(1_000_000_000_000n);
    const external = new Uint8Array(32).fill(9); // NOT a wallet puzzle hash
    const built = buildXchSend(chia as unknown as SendWasm, {
      coins: [pair.coin as never],
      keyByPuzzleHash: new Map([[hx(pair.puzzleHash), { pk: pair.pk } as never]]),
      destPuzzleHash: external,
      amount: 250_000_000_000n,
      fee: 0n,
      changePuzzleHash: pair.puzzleHash,
    });
    const clvm = new chia.Clvm();
    expect(() =>
      decodeCoinOpSummary(asCoins(), clvm as never, built.coinSpends as never, {
        ownXchPhs: new Set([hx(pair.puzzleHash)]),
        asset: 'XCH',
        kind: 'combine',
        fee: 0n,
        inputCoinCount: 1,
      }),
    ).toThrow(/SELF_SEND_VIOLATION/);
  });
});
