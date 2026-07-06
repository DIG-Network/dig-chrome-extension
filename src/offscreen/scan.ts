/**
 * Self-custody HD balance scan (§4.3, §5.7) — pure logic over an injected `ChiaWasm` + `ChainClient`
 * so it is unit-tested with a Node wasm + a fake chain. Derives the wallet's puzzle hashes across
 * BOTH the unhardened and hardened schemes (each to a gap limit), then sums UNSPENT coins from
 * coinset: native XCH at the standard puzzle hashes, and CATs two ways — (1) AUTO-DISCOVERY (#87):
 * every CAT the wallet holds is surfaced by hinted-coin lineage reconstruction (`discoverCats`, the
 * same hint mechanism as NFTs) with NO watch list; and (2) the manual watched/built-in list, queried
 * directly at each CAT puzzle hash (`catPuzzleHash(tail, innerPh)`) — an explicit override that also
 * shows a zero-balance or un-hinted-change CAT. Balances are pooled across all derivations (§6: one
 * wallet = one balance).
 */

import { deriveAccounts, deriveAccount, masterFromSeed, type ChiaWasm } from '@/lib/keystore/derive';
import type { ChainClient } from '@/offscreen/chain';
import { discoverCats, type CatDiscoveryWasm } from '@/offscreen/catDiscovery';

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
 * `gapLimit`, sums unspent XCH at them, AUTO-DISCOVERS every held CAT by hint, then adds any
 * watched/built-in CAT not already discovered by querying its CAT puzzle hash directly.
 */
export async function scanBalances(
  chia: ScanWasm,
  chain: ChainClient,
  opts: { seed: Uint8Array; watchedCats?: string[]; gapLimit?: number; concurrency?: number },
): Promise<BalanceScan> {
  const gapLimit = opts.gapLimit ?? DEFAULT_GAP_LIMIT;
  const accounts = deriveAccounts(chia, opts.seed, {
    schemes: ['unhardened', 'hardened'],
    count: gapLimit,
  });
  const innerPhs = accounts.map((a) => a.puzzleHashHex);

  const xch = await chain.totalUnspent(innerPhs);

  const cats: Record<string, number> = {};

  // (1) Auto-discovery: surface EVERY held CAT by hint (#87), no watch list required. Best-effort —
  // it degrades to the watched path if the chain can't resolve hints or the fan-out errors out, so a
  // flaky coinset never blanks the balances (the SW additionally serves the last cached snapshot).
  if (chain.coinsByHints) {
    try {
      const discovered = await discoverCats(chia as unknown as CatDiscoveryWasm, chain, {
        seed: opts.seed,
        gapLimit,
        ...(opts.concurrency ? { concurrency: opts.concurrency } : {}),
      });
      for (const d of discovered) cats[d.assetId] = d.amount;
    } catch {
      /* discovery is best-effort; fall through to the manual watched-CAT path */
    }
  }

  // (2) Watched / built-in CATs: query any NOT already discovered directly by CAT puzzle hash — an
  // explicit override (a zero-balance token the user still wants shown, or a CAT held only as
  // un-hinted change that hint-discovery can miss).
  for (const rawTail of opts.watchedCats ?? []) {
    const tail = strip0x(rawTail);
    if (tail in cats) continue;
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
