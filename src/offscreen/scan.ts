/**
 * Self-custody HD balance scan (§4.3, §5.7) — pure logic over an injected `ChiaWasm` + `ChainClient`
 * so it is unit-tested with a Node wasm + a fake chain. Derives the wallet's puzzle hashes across
 * BOTH the unhardened and hardened schemes (each to a gap limit), then sums UNSPENT coins from
 * coinset: native XCH at the standard puzzle hashes, and each watched CAT at its CAT puzzle hash
 * (`catPuzzleHash(tail, innerPh)`) over the same inner hashes. Balances are pooled across all
 * derivations (§6: one wallet = one balance).
 */

import { deriveAccounts, deriveAccount, masterFromSeed, type ChiaWasm } from '@/lib/keystore/derive';
import type { ChainClient } from '@/offscreen/chain';

/** Default gap limit per scheme (indexes 0..N-1). A pragmatic fixed window for the read-only scan. */
export const DEFAULT_GAP_LIMIT = 20;

/** A scanned balance snapshot: XCH mojos + per-CAT (asset id → base units). */
export interface BalanceScan {
  xch: number;
  cats: Record<string, number>;
}

/** The `catPuzzleHash` surface (in addition to the derive `ChiaWasm`). */
export interface ScanWasm extends ChiaWasm {
  fromHex(value: string): Uint8Array;
  catPuzzleHash(assetId: Uint8Array, innerPuzzleHash: Uint8Array): Uint8Array;
}

const strip0x = (h: string): string => h.replace(/^0x/i, '').toLowerCase();

/**
 * Scan pooled balances for a seed. Derives inner (standard p2) puzzle hashes for both schemes to
 * `gapLimit`, sums unspent XCH at them, then sums each watched CAT at its CAT puzzle hash.
 */
export async function scanBalances(
  chia: ScanWasm,
  chain: ChainClient,
  opts: { seed: Uint8Array; watchedCats?: string[]; gapLimit?: number },
): Promise<BalanceScan> {
  const gapLimit = opts.gapLimit ?? DEFAULT_GAP_LIMIT;
  const accounts = deriveAccounts(chia, opts.seed, {
    schemes: ['unhardened', 'hardened'],
    count: gapLimit,
  });
  const innerPhs = accounts.map((a) => a.puzzleHashHex);

  const xch = await chain.totalUnspent(innerPhs);

  const cats: Record<string, number> = {};
  for (const rawTail of opts.watchedCats ?? []) {
    const tail = strip0x(rawTail);
    const assetIdBytes = chia.fromHex(tail);
    const catPhs = innerPhs.map((ph) => strip0x(chia.toHex(chia.catPuzzleHash(assetIdBytes, chia.fromHex(ph)))));
    cats[tail] = await chain.totalUnspent(catPhs);
  }

  return { xch, cats };
}

/**
 * The wallet's primary receive address — index 0, unhardened (pooled model, §6). Returns the
 * bech32m `xch1…` address; power users get the full address list in Advanced (a later surface).
 */
export function receiveAddress(chia: ChiaWasm, seed: Uint8Array, prefix = 'xch'): string {
  const master = masterFromSeed(chia, seed);
  try {
    return deriveAccount(chia, master, 0, 'unhardened', prefix).address;
  } finally {
    master.free?.();
  }
}
