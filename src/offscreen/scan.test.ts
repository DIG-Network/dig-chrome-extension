import { describe, it, expect, beforeAll } from 'vitest';
import { scanBalances, receiveAddress, DEFAULT_GAP_LIMIT, type ScanWasm } from './scan';
import { DEFAULT_COINSET_URL, COINSET_BATCH, type ChainClient } from './chain';
import { mnemonicToSeed } from '@/lib/keystore/bip39';
import { loadChiaWasmNode } from '@/test/chiaWasm';
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
  return { totalUnspent: async (phs) => phs.reduce((s, ph) => s + (map[ph.toLowerCase()] ?? 0), 0) };
}

describe('scanBalances', () => {
  it('sums XCH across BOTH schemes (unhardened + hardened) at the derived puzzle hashes', async () => {
    const map = {
      [golden.unhardened[0].puzzleHashHex]: 5_000_000_000_000, // 5 XCH on an unhardened address
      [golden.hardened[0].puzzleHashHex]: 3_000_000_000_000, // 3 XCH on a hardened address
    };
    const res = await scanBalances(chia, fakeChain(map), { seed, gapLimit: 5 });
    expect(res.xch).toBe(8_000_000_000_000); // both schemes pooled
    expect(res.cats).toEqual({});
  });

  it('sums a watched CAT at its CAT puzzle hash over the inner hashes', async () => {
    const innerPh0 = golden.unhardened[0].puzzleHashHex;
    const catPh0 = toHex(chia.catPuzzleHash(chia.fromHex(TAIL), chia.fromHex(innerPh0)));
    const res = await scanBalances(chia, fakeChain({ [catPh0]: 1234 }), { seed, watchedCats: [TAIL], gapLimit: 5 });
    expect(res.xch).toBe(0);
    expect(res.cats[TAIL]).toBe(1234);
  });

  it('returns zeros for an empty wallet', async () => {
    const res = await scanBalances(chia, fakeChain({}), { seed, watchedCats: [TAIL], gapLimit: 3 });
    expect(res.xch).toBe(0);
    expect(res.cats[TAIL]).toBe(0);
  });

  it('normalizes a 0x-prefixed TAIL', async () => {
    const innerPh0 = golden.unhardened[0].puzzleHashHex;
    const catPh0 = toHex(chia.catPuzzleHash(chia.fromHex(TAIL), chia.fromHex(innerPh0)));
    const res = await scanBalances(chia, fakeChain({ [catPh0]: 7 }), { seed, watchedCats: [`0x${TAIL}`], gapLimit: 3 });
    expect(res.cats[TAIL]).toBe(7);
  });

  it('derives the pooled index-0 unhardened receive address', () => {
    expect(receiveAddress(chia, seed)).toBe(golden.unhardened[0].address);
  });

  it('exposes a sane default gap limit', () => {
    expect(DEFAULT_GAP_LIMIT).toBeGreaterThanOrEqual(20);
  });

  it('exposes the coinset defaults', () => {
    expect(DEFAULT_COINSET_URL).toMatch(/coinset/);
    expect(COINSET_BATCH).toBeGreaterThan(0);
  });
});
