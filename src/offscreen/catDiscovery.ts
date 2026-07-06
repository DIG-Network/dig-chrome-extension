/**
 * Self-custody CAT auto-discovery (§18 Tokens, #87) — surface EVERY CAT the wallet holds WITHOUT a
 * manual watch list, by the same hinted-coin lineage reconstruction the NFT discovery uses
 * (`nfts.listNfts`). Runs in the offscreen vault (holds the seed). Pure (injected wasm + chain), so
 * it is unit-tested against the wasm Simulator with a fake chain; read-only — it NEVER signs or
 * broadcasts.
 *
 * Discovery model (mirrors `sendFlow.reconstructCats`, but assetId is UNKNOWN going in):
 *   - A CAT coin's OUTER puzzle hash is `catPuzzleHash(tail, innerP2)` — NOT the wallet's p2 hash —
 *     so a puzzle-hash scan can't find a CAT whose tail you don't already know. But a CAT transfer
 *     HINTS the recipient's inner p2 puzzle hash (the standard Chia received-CAT detection signal),
 *     so the wallet finds candidate coins via coinset `get_coin_records_by_hints` over its derived p2
 *     hashes (both HD schemes) — exactly like NFTs.
 *   - For each hinted unspent coin, its PARENT spend is fetched and `Puzzle.parseChildCats(parentCoin,
 *     parentSolution)` reconstructs the child CATs. A coin is one of OUR CATs iff a reconstructed
 *     child IS this coin and its `info.p2PuzzleHash` is one of the wallet's derived inner hashes; its
 *     `info.assetId` is the TAIL. Balances are aggregated per tail across all derivations (§6: one
 *     wallet = one balance).
 *
 * The coinset fan-out is bounded (`concurrency`, default 4) and each read is retried with backoff
 * (coinset is flaky under parallelism) — see `concurrency.ts`.
 */

import { buildKeyring, type SendFlowWasm } from '@/offscreen/sendFlow';
import type { ChainClient, ChainCoin } from '@/offscreen/chain';
import { mapWithConcurrency, withRetry, type Sleep } from '@/offscreen/concurrency';

const strip0x = (h: string): string => h.replace(/^0x/i, '').toLowerCase();

// ── Minimal structural wasm surfaces (focused casts, per sendFlow/nfts) ────────────────────────────
interface CatObj {
  coin: { coinId(): Uint8Array };
  info: { assetId: Uint8Array; p2PuzzleHash: Uint8Array };
}
interface CatPuzzle {
  parseChildCats(parentCoin: unknown, parentSolution: unknown): CatObj[] | undefined;
}
interface CatProgram {
  puzzle(): CatPuzzle;
}
interface CatClvm {
  deserialize(bytes: Uint8Array): CatProgram;
}

/**
 * The wasm surface CAT discovery needs: hex codecs, a `Clvm` allocator to parse parent spends, plus
 * the derivation surface (via a cast to {@link SendFlowWasm}) that {@link buildKeyring} consumes.
 * Standalone so callers pass the offscreen wasm with a single focused cast.
 */
export interface CatDiscoveryWasm {
  toHex(bytes: Uint8Array): string;
  fromHex(hex: string): Uint8Array;
  Clvm: new () => CatClvm;
}

/** One discovered CAT: its TAIL (asset id, hex) + the wallet-wide held amount (base units) + coins. */
export interface DiscoveredCat {
  assetId: string;
  amount: number;
  coinCount: number;
}

/** Tuning for the coinset read fan-out (bounded concurrency + retry). */
export interface DiscoverOpts {
  seed: Uint8Array;
  gapLimit?: number;
  /** Max concurrent coinset reads (default 4 — coinset degrades above this). */
  concurrency?: number;
  /** Extra retry attempts per flaky read (default 2). */
  retries?: number;
  /** Injectable backoff sleep (tests). */
  sleep?: Sleep;
}

const asHex = (chia: CatDiscoveryWasm, b: Uint8Array): string => strip0x(chia.toHex(b));

/**
 * Reconstruct the wallet-owned CAT for a hinted coin, or null if the coin is not one of ours. Uses a
 * fresh `Clvm` per coin: a CAT's `info` is plain bytes (assetId + p2 hash), so — unlike NFTs — there
 * is no cross-allocator handle to keep alive, and we only read those bytes.
 */
async function reconstructOwnedCat(
  chia: CatDiscoveryWasm,
  chain: ChainClient,
  ownedPhs: Set<string>,
  coin: ChainCoin,
  retry: { retries: number; sleep?: Sleep },
): Promise<{ assetId: string; amount: bigint } | null> {
  const parentSpend = await withRetry(() => chain.getCoinSpend(asHex(chia, coin.parentCoinInfo)), retry);
  if (!parentSpend) return null;
  const clvm = new chia.Clvm();
  const puzzle = clvm.deserialize(parentSpend.puzzleReveal).puzzle();
  const children = puzzle.parseChildCats(parentSpend.coin, clvm.deserialize(parentSpend.solution)) ?? [];
  const wanted = asHex(chia, coin.coinId());
  const mine = children.find((c) => asHex(chia, c.coin.coinId()) === wanted);
  if (!mine) return null;
  if (!ownedPhs.has(asHex(chia, mine.info.p2PuzzleHash))) return null;
  return { assetId: asHex(chia, mine.info.assetId), amount: coin.amount };
}

/**
 * Discover every CAT the wallet holds. Derives the HD keyring (both schemes to `gapLimit`), finds the
 * coins hinted to those inner puzzle hashes (coinset `get_coin_records_by_hints`), reconstructs each
 * via its parent spend, keeps those actually owned, and aggregates the held amount per TAIL. The
 * coinset fan-out is bounded + retried. Read-only.
 */
export async function discoverCats(
  chia: CatDiscoveryWasm,
  chain: ChainClient,
  opts: DiscoverOpts,
): Promise<DiscoveredCat[]> {
  if (!chain.coinsByHints) throw new Error('HINT_LOOKUP_UNAVAILABLE: the chain client cannot resolve hints');
  const retry = { retries: opts.retries ?? 2, ...(opts.sleep ? { sleep: opts.sleep } : {}) };
  const keyring = buildKeyring(chia as unknown as SendFlowWasm, opts.seed, { count: opts.gapLimit ?? 20 });
  const ownedPhs = new Set(keyring.map((k) => k.puzzleHashHex));
  const coins = await withRetry(() => chain.coinsByHints!([...ownedPhs]), retry);

  const reconstructed = await mapWithConcurrency(coins, opts.concurrency ?? 4, (coin) =>
    reconstructOwnedCat(chia, chain, ownedPhs, coin, retry),
  );

  const byTail = new Map<string, { amount: bigint; coinCount: number }>();
  for (const r of reconstructed) {
    if (!r) continue;
    const cur = byTail.get(r.assetId) ?? { amount: 0n, coinCount: 0 };
    byTail.set(r.assetId, { amount: cur.amount + r.amount, coinCount: cur.coinCount + 1 });
  }
  return [...byTail.entries()].map(([assetId, v]) => ({ assetId, amount: Number(v.amount), coinCount: v.coinCount }));
}
