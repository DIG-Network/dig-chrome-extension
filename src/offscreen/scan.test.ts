import { describe, it, expect, beforeAll } from 'vitest';
import { scanBalances, receiveAddress, type ScanWasm } from './scan';
import { buildKeyring, type SendFlowWasm } from './sendFlow';
import { type SigningWasm } from './signing';
import { DEFAULT_COINSET_URL, COINSET_BATCH, type ChainClient } from './chain';
import { mnemonicToSeed } from '@/lib/keystore/bip39';
import { loadChiaWasmNode } from '@/test/chiaWasm';
import { simChain, issueCatTo, transferCatHinted, type CatSimWasm } from '@/test/catSim';
import golden from '@/lib/keystore/derive.golden.json';

// A CAT asset id (TAIL) — any valid 32-byte hex; catPuzzleHash is deterministic over it.
const TAIL = 'a406d3a9de984d03c9591c10d917593b434d5263cabe2b42f6b367df16832f81';
const toHex = (u: Uint8Array): string => Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');

let chia: ScanWasm;
let seed: Uint8Array;

beforeAll(async () => {
  chia = (await loadChiaWasmNode()) as ScanWasm;
  seed = await mnemonicToSeed(golden.mnemonic);
});

/** A fake chain: sums amounts from a puzzle-hash → base-units map over each query. */
function fakeChain(map: Record<string, number>): ChainClient {
  return {
    totalUnspent: async (phs) => phs.reduce((s, ph) => s + (map[ph.toLowerCase()] ?? 0), 0),
    unspentCoins: async () => [],
    pushSpendBundle: async () => ({ success: true }),
    coinConfirmed: async () => false,
    getCoinSpend: async () => null,
    coinRecords: async () => [],
  };
}

describe('scanBalances (single active index, #165)', () => {
  it('sums XCH across BOTH schemes (unhardened + hardened) at the ACTIVE index only', async () => {
    const map = {
      [golden.unhardened[0].puzzleHashHex]: 5_000_000_000_000, // 5 XCH on an unhardened address
      [golden.hardened[0].puzzleHashHex]: 3_000_000_000_000, // 3 XCH on a hardened address
    };
    const res = await scanBalances(chia, fakeChain(map), { seed, activeIndex: 0 });
    expect(res.xch).toBe(8_000_000_000_000); // both schemes pooled at index 0
    expect(res.cats).toEqual({});
  });

  it('does NOT sum balances sitting at a non-active index — no multi-index sweep', async () => {
    // Funds at index 1's addresses must be invisible while index 0 is active — proves the scan
    // derives exactly the active index, never a gap-limit range across other indexes.
    const map = {
      [golden.unhardened[1].puzzleHashHex]: 9_000_000_000_000,
      [golden.hardened[1].puzzleHashHex]: 9_000_000_000_000,
    };
    const res = await scanBalances(chia, fakeChain(map), { seed, activeIndex: 0 });
    expect(res.xch).toBe(0);
  });

  it('navigating to a different active index scans THAT index instead', async () => {
    const map = { [golden.unhardened[1].puzzleHashHex]: 2_000_000_000_000 };
    const atIndex0 = await scanBalances(chia, fakeChain(map), { seed, activeIndex: 0 });
    const atIndex1 = await scanBalances(chia, fakeChain(map), { seed, activeIndex: 1 });
    expect(atIndex0.xch).toBe(0);
    expect(atIndex1.xch).toBe(2_000_000_000_000);
  });

  it('activeIndex defaults to 0 when omitted', async () => {
    const map = { [golden.unhardened[0].puzzleHashHex]: 42 };
    expect((await scanBalances(chia, fakeChain(map), { seed })).xch).toBe(42);
  });

  it('sums a watched CAT at its CAT puzzle hash over the inner hashes', async () => {
    const innerPh0 = golden.unhardened[0].puzzleHashHex;
    const catPh0 = toHex(chia.catPuzzleHash(chia.fromHex(TAIL), chia.fromHex(innerPh0)));
    const res = await scanBalances(chia, fakeChain({ [catPh0]: 1234 }), { seed, watchedCats: [TAIL], activeIndex: 0 });
    expect(res.xch).toBe(0);
    expect(res.cats[TAIL]).toBe(1234);
  });

  it('returns zeros for an empty wallet', async () => {
    const res = await scanBalances(chia, fakeChain({}), { seed, watchedCats: [TAIL], activeIndex: 0 });
    expect(res.xch).toBe(0);
    expect(res.cats[TAIL]).toBe(0);
  });

  it('normalizes a 0x-prefixed TAIL', async () => {
    const innerPh0 = golden.unhardened[0].puzzleHashHex;
    const catPh0 = toHex(chia.catPuzzleHash(chia.fromHex(TAIL), chia.fromHex(innerPh0)));
    const res = await scanBalances(chia, fakeChain({ [catPh0]: 7 }), { seed, watchedCats: [`0x${TAIL}`], activeIndex: 0 });
    expect(res.cats[TAIL]).toBe(7);
  });

  it('auto-discovers a held CAT into balances.cats without a watch list (#87)', async () => {
    const ring = buildKeyring(chia as unknown as SendFlowWasm, seed, { index: 0 });
    const csim = chia as unknown as CatSimWasm;
    const sigw = chia as unknown as SigningWasm;
    const sim = new csim.Simulator();
    sim.newCoin(chia.fromHex(ring[0].puzzleHashHex), 5_000_000_000_000n);
    const assetIdHex = issueCatTo(csim, sigw, sim, ring, 1000n);
    // ring[1] is the SAME index's hardened address — a real transfer between the wallet's own
    // addresses at the active index, exactly what discovery must find.
    await transferCatHinted(csim, sigw, sim, ring, assetIdHex, ring[1].puzzleHashHex, 1000n);

    const res = await scanBalances(chia, simChain(csim, sim), { seed, activeIndex: 0 });
    expect(res.cats[assetIdHex]).toBe(1000); // discovered, not watched
  });

  it('does not re-query a watched CAT that was already auto-discovered', async () => {
    const ring = buildKeyring(chia as unknown as SendFlowWasm, seed, { index: 0 });
    const csim = chia as unknown as CatSimWasm;
    const sigw = chia as unknown as SigningWasm;
    const sim = new csim.Simulator();
    sim.newCoin(chia.fromHex(ring[0].puzzleHashHex), 5_000_000_000_000n);
    const assetIdHex = issueCatTo(csim, sigw, sim, ring, 1000n);
    await transferCatHinted(csim, sigw, sim, ring, assetIdHex, ring[1].puzzleHashHex, 1000n);

    // Even though it is ALSO in the watch list, the discovered amount wins (no double count / re-query).
    const res = await scanBalances(chia, simChain(csim, sim), { seed, watchedCats: [assetIdHex], activeIndex: 0 });
    expect(res.cats[assetIdHex]).toBe(1000);
  });

  it('derives the active index (default 0) unhardened receive address', () => {
    expect(receiveAddress(chia, seed)).toBe(golden.unhardened[0].address);
    expect(receiveAddress(chia, seed, 0)).toBe(golden.unhardened[0].address);
  });

  it('navigating to a different index derives THAT index\'s receive address', () => {
    expect(receiveAddress(chia, seed, 1)).toBe(golden.unhardened[1].address);
    expect(receiveAddress(chia, seed, 2)).toBe(golden.unhardened[2].address);
  });

  it('exposes the coinset defaults', () => {
    expect(DEFAULT_COINSET_URL).toMatch(/coinset/);
    expect(COINSET_BATCH).toBeGreaterThan(0);
  });
});
