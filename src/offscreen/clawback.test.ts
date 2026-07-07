import { describe, it, expect, beforeAll } from 'vitest';
import {
  clawbackPuzzleHashHex,
  discoverIncomingClawbacks,
  findClawbackCoin,
  prepareClawbackAction,
  type ClawbackInfo,
  type ClawbackWasm,
} from './clawback';
import { buildKeyring, prepareXchSend, signAndBundle, type SendFlowWasm } from './sendFlow';
import { TESTNET11_AGG_SIG_ME } from './signing';
import type { ChainClient, ChainCoin, ChainCoinSpend, ChainSpendBundle } from './chain';
import { mnemonicToSeed } from '@/lib/keystore/bip39';
import { loadChiaWasmNode } from '@/test/chiaWasm';
import golden from '@/lib/keystore/derive.golden.json';

/**
 * Chia clawback (#152) proven against the wasm Simulator via the REAL vault path: send-with-clawback
 * (`sendFlow.prepareXchSend`'s `clawbackSeconds` option) builds a coin locked under `ClawbackV2`;
 * this suite proves the receiver can only CLAIM after the window (early claim rejected on-chain),
 * the sender can CLAW BACK any time before that, discovery finds the coin both by hint (receiver) and
 * by recomputed puzzle hash (either side), and coin math (fee reservation) balances. Never broadcasts
 * to mainnet — every push here is `Simulator.newTransaction`/`spendCoins` (local, in-memory).
 */
interface SimHandle {
  newCoin(puzzleHash: Uint8Array, amount: bigint): ChainCoin;
  newTransaction(bundle: ChainSpendBundle): void;
  createBlock(): void;
  passTime(seconds: bigint): void;
  nextTimestamp(): bigint;
  unspentCoins(puzzleHash: Uint8Array, includeHints: boolean): ChainCoin[];
  coinSpend(coinId: Uint8Array): ChainCoinSpend | undefined;
}
interface TestWasm {
  fromHex(h: string): Uint8Array;
  toHex(b: Uint8Array): string;
  Address: new (puzzleHash: Uint8Array, prefix: string) => { encode(): string };
  Simulator: new () => SimHandle;
  SpendBundle: new (coinSpends: unknown, sig: unknown) => ChainSpendBundle;
}

let chia: TestWasm;
const flow = () => chia as unknown as SendFlowWasm;
const cbWasm = () => chia as unknown as ClawbackWasm;
beforeAll(async () => {
  chia = (await loadChiaWasmNode()) as unknown as TestWasm;
});

/** A sim-backed ChainClient supporting hint lookups (`includeHints: true`), for clawback discovery. */
function simChain(sim: SimHandle): ChainClient {
  return {
    totalUnspent: async () => 0,
    unspentCoins: async (phs) => phs.flatMap((h) => sim.unspentCoins(chia.fromHex(h), false)),
    coinsByHints: async (hints) => hints.flatMap((h) => sim.unspentCoins(chia.fromHex(h), true)),
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

/** Fund the golden index-0 unhardened address and send a clawback-windowed XCH transfer to `recipient`.
 * Returns the sim + chain + the sender/receiver keyrings + the resulting `clawbackInfo`. */
async function sendWithClawback(opts: { windowSeconds: bigint; amount?: bigint; fee?: bigint }) {
  const senderSeed = await mnemonicToSeed(golden.mnemonic);
  const senderKeyring = buildKeyring(flow(), senderSeed, { index: 0 });
  const ph0 = senderKeyring[0].puzzleHashHex;
  const sim = new chia.Simulator();
  sim.newCoin(chia.fromHex(ph0), 1_000_000_000_000n);
  const chain = simChain(sim);

  // A second, distinct index acts as the "receiver" — its own keyring, so claim requires ITS key.
  const receiverKeyring = buildKeyring(flow(), senderSeed, { index: 7 });
  const receiverAddress = new chia.Address(chia.fromHex(receiverKeyring[0].puzzleHashHex), 'xch').encode();

  const amount = opts.amount ?? 250_000_000_000n;
  const fee = opts.fee ?? 0n;
  const seconds = sim.nextTimestamp() + opts.windowSeconds;
  const prepared = await prepareXchSend(flow(), chain, {
    seed: senderSeed,
    recipient: receiverAddress,
    amount,
    fee,
    activeIndex: 0,
    clawbackSeconds: seconds,
  });
  expect(prepared.clawbackInfo).toBeDefined();
  const bundle = signAndBundle(flow(), prepared.coinSpends, prepared.secretKeys, TESTNET11_AGG_SIG_ME);
  const push = await chain.pushSpendBundle(bundle);
  expect(push.success).toBe(true);

  return { sim, chain, senderKeyring, receiverKeyring, info: prepared.clawbackInfo as ClawbackInfo, senderSeed };
}

describe('send-with-clawback (prepareXchSend clawbackSeconds option)', () => {
  it('locks the coin under the ClawbackV2 puzzle hash, not the receiver’s own address', async () => {
    const { info } = await sendWithClawback({ windowSeconds: 3600n });
    const expectedPh = clawbackPuzzleHashHex(cbWasm(), info);
    expect(expectedPh).not.toBe(info.receiverPuzzleHashHex);
    expect(expectedPh).not.toBe(info.senderPuzzleHashHex);
  });

  it('the locked coin is discoverable by the receiver via hint lookup, matching the recomputed puzzle hash', async () => {
    const { chain, info } = await sendWithClawback({ windowSeconds: 3600n });
    const coin = await findClawbackCoin(cbWasm(), chain, info);
    expect(coin).not.toBeNull();
    expect(coin!.amount).toBe(info.amount);
    expect(chain.coinsByHints).toBeDefined();
    const hinted = await chain.coinsByHints!([info.receiverPuzzleHashHex]);
    expect(hinted.some((c) => chia.toHex(c.coinId()) === chia.toHex(coin!.coinId()))).toBe(true);
  });

  it('discoverIncomingClawbacks reconstructs the params for the receiver’s own keyring', async () => {
    const { chain, receiverKeyring, info } = await sendWithClawback({ windowSeconds: 3600n });
    const found = await discoverIncomingClawbacks(cbWasm(), chain, receiverKeyring);
    expect(found).toHaveLength(1);
    expect(found[0]!.info).toEqual(info);
  });

  it('discoverIncomingClawbacks finds nothing for an unrelated keyring', async () => {
    const { chain, senderSeed } = await sendWithClawback({ windowSeconds: 3600n });
    const unrelated = buildKeyring(flow(), senderSeed, { index: 99 });
    const found = await discoverIncomingClawbacks(cbWasm(), chain, unrelated);
    expect(found).toHaveLength(0);
  });
});

describe('claim (receiver) — timelock enforced', () => {
  it('rejects an early claim before the window (ASSERT_SECONDS_ABSOLUTE fails on-chain)', async () => {
    const { chain, receiverKeyring, info } = await sendWithClawback({ windowSeconds: 3600n });
    const prepared = await prepareClawbackAction(cbWasm(), chain, { keyring: receiverKeyring, info, direction: 'claim', fee: 0n });
    const bundle = signAndBundle(flow(), prepared.coinSpends, prepared.secretKeys, TESTNET11_AGG_SIG_ME);
    await expect(chain.pushSpendBundle(bundle).then((r) => { if (!r.success) throw new Error(r.error); })).rejects.toThrow();
  });

  it('succeeds after the window passes, delivering amount minus fee to the receiver’s own address', async () => {
    const { sim, chain, receiverKeyring, info } = await sendWithClawback({ windowSeconds: 5n, amount: 300_000_000_000n });
    sim.passTime(10n); // advance past the 5s window
    const fee = 1_000n;
    const prepared = await prepareClawbackAction(cbWasm(), chain, { keyring: receiverKeyring, info, direction: 'claim', fee });
    expect(prepared.amountOut).toBe(info.amount - fee);
    const bundle = signAndBundle(flow(), prepared.coinSpends, prepared.secretKeys, TESTNET11_AGG_SIG_ME);
    const push = await chain.pushSpendBundle(bundle);
    expect(push.success).toBe(true);

    const receiverCoins = await chain.unspentCoins([info.receiverPuzzleHashHex]);
    expect(receiverCoins.some((c) => c.amount === info.amount - fee)).toBe(true);
    // the locked coin is gone (spent) — findClawbackCoin (unspent-only) no longer sees it.
    expect(await findClawbackCoin(cbWasm(), chain, info)).toBeNull();
  });

  it('MISSING_KEY when the claiming keyring does not own the receiver address', async () => {
    const { chain, senderSeed, info } = await sendWithClawback({ windowSeconds: 3600n });
    const wrongKeyring = buildKeyring(flow(), senderSeed, { index: 42 });
    await expect(prepareClawbackAction(cbWasm(), chain, { keyring: wrongKeyring, info, direction: 'claim', fee: 0n })).rejects.toThrow(/MISSING_KEY/);
  });
});

describe('claw back (sender) — no timelock restriction', () => {
  it('succeeds BEFORE the window elapses, returning the full amount to the sender’s own address', async () => {
    const { chain, senderKeyring, info } = await sendWithClawback({ windowSeconds: 3600n, amount: 250_000_000_000n });
    const prepared = await prepareClawbackAction(cbWasm(), chain, { keyring: senderKeyring, info, direction: 'reclaim', fee: 0n });
    expect(prepared.amountOut).toBe(info.amount);
    const bundle = signAndBundle(flow(), prepared.coinSpends, prepared.secretKeys, TESTNET11_AGG_SIG_ME);
    const push = await chain.pushSpendBundle(bundle);
    expect(push.success).toBe(true);
    expect(await findClawbackCoin(cbWasm(), chain, info)).toBeNull();
  });

  it('once reclaimed, a subsequent claim attempt fails (the coin is already spent)', async () => {
    const { chain, senderKeyring, receiverKeyring, info } = await sendWithClawback({ windowSeconds: 3600n });
    const reclaim = await prepareClawbackAction(cbWasm(), chain, { keyring: senderKeyring, info, direction: 'reclaim', fee: 0n });
    const reclaimBundle = signAndBundle(flow(), reclaim.coinSpends, reclaim.secretKeys, TESTNET11_AGG_SIG_ME);
    expect((await chain.pushSpendBundle(reclaimBundle)).success).toBe(true);

    await expect(prepareClawbackAction(cbWasm(), chain, { keyring: receiverKeyring, info, direction: 'claim', fee: 0n })).rejects.toThrow(/NO_CLAWBACK_COIN/);
  });

  it('rejects a reclaim broadcast AFTER the window elapses — the cutover is strict, not a race', async () => {
    const { sim, chain, senderKeyring, info } = await sendWithClawback({ windowSeconds: 5n });
    sim.passTime(10n); // advance past the window — only the receiver can act now
    const prepared = await prepareClawbackAction(cbWasm(), chain, { keyring: senderKeyring, info, direction: 'reclaim', fee: 0n });
    const bundle = signAndBundle(flow(), prepared.coinSpends, prepared.secretKeys, TESTNET11_AGG_SIG_ME);
    await expect(chain.pushSpendBundle(bundle).then((r) => { if (!r.success) throw new Error(r.error); })).rejects.toThrow();
  });

  it('MISSING_KEY when the reclaiming keyring does not own the sender address', async () => {
    const { chain, senderSeed, info } = await sendWithClawback({ windowSeconds: 3600n });
    const wrongKeyring = buildKeyring(flow(), senderSeed, { index: 42 });
    await expect(prepareClawbackAction(cbWasm(), chain, { keyring: wrongKeyring, info, direction: 'reclaim', fee: 0n })).rejects.toThrow(/MISSING_KEY/);
  });

  it('BAD_REQUEST when the fee exceeds the clawback amount', async () => {
    const { chain, senderKeyring, info } = await sendWithClawback({ windowSeconds: 3600n, amount: 1000n });
    await expect(prepareClawbackAction(cbWasm(), chain, { keyring: senderKeyring, info, direction: 'reclaim', fee: 5000n })).rejects.toThrow(/BAD_REQUEST/);
  });
});

describe('discoverIncomingClawbacks guard', () => {
  it('throws HINT_LOOKUP_UNAVAILABLE when the chain client lacks coinsByHints', async () => {
    const noHintChain: ChainClient = {
      totalUnspent: async () => 0,
      unspentCoins: async () => [],
      pushSpendBundle: async () => ({ success: true }),
      coinConfirmed: async () => true,
      getCoinSpend: async () => null,
      coinRecords: async () => [],
    };
    const seed = await mnemonicToSeed(golden.mnemonic);
    const keyring = buildKeyring(flow(), seed, { index: 0 });
    await expect(discoverIncomingClawbacks(cbWasm(), noHintChain, keyring)).rejects.toThrow(/HINT_LOOKUP_UNAVAILABLE/);
  });
});
