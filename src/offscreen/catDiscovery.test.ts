import { describe, it, expect, beforeAll } from 'vitest';
import { discoverCats, type CatDiscoveryWasm } from './catDiscovery';
import { buildKeyring, type SendFlowWasm } from './sendFlow';
import { type SigningWasm } from './signing';
import type { ChainClient } from './chain';
import { mnemonicToSeed } from '@/lib/keystore/bip39';
import { loadChiaWasmNode } from '@/test/chiaWasm';
import { simChain, issueCatTo, transferCatHinted, type CatSimWasm } from '@/test/catSim';
import golden from '@/lib/keystore/derive.golden.json';

/**
 * CAT auto-discovery, proven authoritatively against the wasm Simulator: a CAT is issued to a
 * seed-derived wallet and then TRANSFERRED (with the standard recipient hint) to another of the
 * wallet's own addresses; `discoverCats` then finds it by hint, reconstructs its lineage, and reports
 * the right TAIL + aggregated amount — without any watch list. Read-only in CI (never broadcasts).
 */
let chia: CatSimWasm & CatDiscoveryWasm;
const cat = () => chia as unknown as CatDiscoveryWasm;
const flow = () => chia as unknown as SendFlowWasm;
const sig = () => chia as unknown as SigningWasm;

beforeAll(async () => {
  chia = (await loadChiaWasmNode()) as unknown as CatSimWasm & CatDiscoveryWasm;
});

describe('discoverCats (Simulator-validated)', () => {
  it('auto-discovers a held CAT by hint with its tail + aggregated amount', async () => {
    const seed = await mnemonicToSeed(golden.mnemonic);
    const ring = buildKeyring(flow(), seed, { index: 0 });
    const sim = new chia.Simulator();
    sim.newCoin(chia.fromHex(ring[0].puzzleHashHex), 5_000_000_000_000n);
    const assetIdHex = issueCatTo(chia, sig(), sim, ring, 1000n);
    // ring[1] is the SAME index's hardened address — a real transfer between the wallet's own
    // addresses at the active index.
    await transferCatHinted(chia, sig(), sim, ring, assetIdHex, ring[1].puzzleHashHex, 1000n);

    const discovered = await discoverCats(cat(), simChain(chia, sim), { seed, activeIndex: 0, retries: 0 });
    const mine = discovered.find((d) => d.assetId === assetIdHex);
    expect(mine, 'the held CAT should be discovered without any watch list').toBeTruthy();
    expect(mine!.amount).toBe(1000);
    expect(mine!.coinCount).toBe(1);
  });

  it('returns [] when the wallet holds no CATs (only XCH)', async () => {
    const seed = await mnemonicToSeed(golden.mnemonic);
    const ring = buildKeyring(flow(), seed, { index: 0 });
    const sim = new chia.Simulator();
    sim.newCoin(chia.fromHex(ring[0].puzzleHashHex), 1_000_000_000_000n);
    const discovered = await discoverCats(cat(), simChain(chia, sim), { seed, activeIndex: 0, retries: 0 });
    expect(discovered).toEqual([]);
  });

  it('throws HINT_LOOKUP_UNAVAILABLE when the chain client cannot resolve hints', async () => {
    const seed = await mnemonicToSeed(golden.mnemonic);
    const noHints: ChainClient = {
      totalUnspent: async () => 0,
      unspentCoins: async () => [],
      coinRecords: async () => [],
      getCoinSpend: async () => null,
      pushSpendBundle: async () => ({ success: true }),
      coinConfirmed: async () => false,
    };
    await expect(discoverCats(cat(), noHints, { seed, activeIndex: 0, retries: 0 })).rejects.toThrow('HINT_LOOKUP_UNAVAILABLE');
  });

  it('retries a flaky hint query with backoff, then succeeds', async () => {
    const seed = await mnemonicToSeed(golden.mnemonic);
    let hintCalls = 0;
    const flaky: ChainClient = {
      totalUnspent: async () => 0,
      unspentCoins: async () => [],
      coinRecords: async () => [],
      getCoinSpend: async () => null,
      pushSpendBundle: async () => ({ success: true }),
      coinConfirmed: async () => false,
      coinsByHints: async () => {
        hintCalls++;
        if (hintCalls < 2) throw new Error('coinset decode error');
        return [];
      },
    };
    const discovered = await discoverCats(cat(), flaky, { seed, activeIndex: 0, retries: 2, sleep: async () => {} });
    expect(hintCalls).toBe(2);
    expect(discovered).toEqual([]);
  });
});
