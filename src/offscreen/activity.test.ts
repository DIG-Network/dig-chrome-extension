import { describe, it, expect, beforeAll } from 'vitest';
import { indexActivity, type ActivityWasm } from './activity';
import { buildXchSend, type SendWasm } from './send';
import { buildKeyring, type SendFlowWasm } from './sendFlow';
import { signCoinSpends, TESTNET11_AGG_SIG_ME, type SigningWasm } from './signing';
import type { ChainClient, ChainCoin, ChainCoinRecord, ChainCoinSpend, ChainSpendBundle } from './chain';
import { mnemonicToSeed } from '@/lib/keystore/bip39';
import { loadChiaWasmNode } from '@/test/chiaWasm';
import golden from '@/lib/keystore/derive.golden.json';

/**
 * The activity indexer proven against the wasm Simulator: fund a seed-derived address (a RECEIVED
 * coin whose parent isn't ours), spend it to a stranger (SENT), then index → both events surface.
 */
interface CoinState {
  coin: ChainCoin & { amount: bigint };
  spentHeight?: number;
  createdHeight?: number;
}
interface SimHandle {
  newCoin(puzzleHash: Uint8Array, amount: bigint): ChainCoin & { amount: bigint };
  newTransaction(bundle: ChainSpendBundle): void;
  createBlock(): void;
  lookupPuzzleHashes(puzzleHashes: Uint8Array[], includeHints: boolean): CoinState[];
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
beforeAll(async () => {
  chia = (await loadChiaWasmNode()) as unknown as TestWasm;
});

/** A sim-backed ChainClient exposing coin records (incl. spent) + parent spends for the indexer. */
function simChain(sim: SimHandle): ChainClient {
  return {
    totalUnspent: async () => 0,
    unspentCoins: async (phs) =>
      phs.flatMap((h) => sim.lookupPuzzleHashes([chia.fromHex(h)], false).filter((s) => s.spentHeight == null).map((s) => s.coin)),
    pushSpendBundle: async (b) => {
      sim.newTransaction(b);
      sim.createBlock();
      return { success: true };
    },
    coinConfirmed: async () => true,
    getCoinSpend: async (idHex) => sim.coinSpend(chia.fromHex(idHex)) ?? null,
    coinRecords: async (phs): Promise<ChainCoinRecord[]> =>
      phs.flatMap((h) =>
        sim.lookupPuzzleHashes([chia.fromHex(h)], false).map((s) => ({
          coin: s.coin,
          spent: s.spentHeight != null,
          confirmedHeight: s.createdHeight ?? 0,
          spentHeight: s.spentHeight ?? 0,
          timestamp: 0,
        })),
      ),
  };
}

describe('indexActivity', () => {
  it('reconstructs a received + a sent XCH event from chain', async () => {
    const seed = await mnemonicToSeed(golden.mnemonic);
    const ring = buildKeyring(chia as unknown as SendFlowWasm, seed, { count: 2 });
    const ph0 = ring[0].puzzleHashHex;

    const sim = new chia.Simulator();
    const received = sim.newCoin(chia.fromHex(ph0), 1_000_000_000_000n); // parent is not ours → RECEIVED
    sim.createBlock();

    // Spend it to a stranger → SENT.
    const dest = new Uint8Array(32).fill(9);
    const built = buildXchSend(chia as unknown as SendWasm, {
      coins: [received],
      keyByPuzzleHash: new Map([[ph0, { pk: ring[0].pk }]]),
      destPuzzleHash: dest,
      amount: 250_000_000_000n,
      fee: 1_000_000n,
      changePuzzleHash: chia.fromHex(ph0),
    });
    const sig = signCoinSpends(chia as unknown as SigningWasm, built.coinSpends, [ring[0].sk], TESTNET11_AGG_SIG_ME);
    sim.newTransaction(new chia.SpendBundle(built.coinSpends, sig));
    sim.createBlock();

    const { events, cursorHeight } = await indexActivity(chia as unknown as ActivityWasm, simChain(sim), { seed, gapLimit: 2 });

    const recv = events.find((e) => e.kind === 'received');
    const sent = events.find((e) => e.kind === 'sent');
    expect(recv?.asset).toBe('XCH');
    expect(recv?.amount).toBe('1000000000000');
    expect(sent?.asset).toBe('XCH');
    expect(sent?.amount).toBe('250000000000'); // the stranger output (change back to us is excluded)
    expect(sent?.counterparty).toBe(new chia.Address(dest, 'xch').encode());
    expect(cursorHeight).toBeGreaterThan(0);
    // newest first
    expect(events[0].height).toBeGreaterThanOrEqual(events[events.length - 1].height);
  });

  it('returns no events for an unused wallet', async () => {
    const seed = await mnemonicToSeed(golden.mnemonic);
    const sim = new chia.Simulator();
    const { events } = await indexActivity(chia as unknown as ActivityWasm, simChain(sim), { seed, gapLimit: 2 });
    expect(events).toEqual([]);
  });
});
