/**
 * Self-custody CAT issuance / minting (#97, extension-parity P2) — mint a BRAND NEW CAT (create its
 * asset id for the first time) from an issuance spend in the vault, assembled from
 * `chia-wallet-sdk-wasm` primitives so the resulting TAIL/asset id is byte-identical to the canonical
 * `chia-sdk-driver` construction (interoperates with Sage / dexie / any other CAT2 wallet). Runs in
 * the offscreen vault (holds the seed). Pure (injected wasm + chain); the issuance money path is
 * proven consensus-valid by a Simulator test (`catIssuance.test.ts`) — nothing is broadcast in CI.
 *
 * Two issuance modes, both driven by the wasm's `Action` system (no new wasm surface needed — CAT
 * issuance ships in the same `chia-wallet-sdk-wasm` build the offer/NFT/DID engines already use):
 *
 *   - **single** (`Action.singleIssueCat`): a "genesis by coin id" TAIL — the asset id is bound to
 *     ONE specific funding coin, so it can be issued exactly once, ever. Fixed supply from the
 *     moment of mint; no further minting is possible under any circumstance. This is the common
 *     "create a token" case (mirrors Sage's "Issue Token").
 *   - **multi** (`Action.issueCat` with a hand-curried TAIL): an "everything with signature" TAIL —
 *     curried with THIS wallet's own synthetic public key at the active index — authorizes ANY
 *     future mint/melt as long as it is signed by that same key. The initial issuance signs the
 *     TAIL's own `AGG_SIG_ME` condition through the SAME generic `signing.ts` machinery every other
 *     spend uses (the condition surfaces in `puzzle.run().value.toList()` like any other), so no
 *     bespoke signing path is needed. Re-minting later (`Action.runTail`) is a natural follow-up,
 *     not built here (the ticket's bar is the issuance spend itself).
 *
 * The newly-created CAT (and any XCH change) auto-routes to `changePuzzleHash` (index-0's own p2
 * puzzle hash) — the SAME "unrouted new asset defaults to the `Spends` change address" behavior
 * `nfts.ts`'s `prepareNftMint` relies on for `Action.mintNft`. The minted asset id is read back from
 * `FinishedSpends.spend()`'s `Outputs.cats()`/`cat(id)` (mirrors `outputs.nft(...)` there) — this is
 * ALSO the strongest available proof the curry was built correctly: `Outputs` is the wasm's own
 * decode of what it just built, independent of any manual tree-hash math on this side.
 */

import { buildKeyring, type SendFlowWasm } from '@/offscreen/sendFlow';
import { type SigCoinSpend, type SigSecretKey } from '@/offscreen/signing';
import type { ChainClient } from '@/offscreen/chain';

const strip0x = (h: string): string => h.replace(/^0x/i, '').toLowerCase();

// ── Minimal structural wasm surfaces (focused casts, per the other offscreen engines) ─────────────
interface IssuanceCoin {
  coinId(): Uint8Array;
  puzzleHash: Uint8Array;
  amount: bigint;
}
interface IssuanceCat {
  coin: IssuanceCoin;
  info: { assetId: Uint8Array; p2PuzzleHash: Uint8Array };
}
interface IssuanceOutputs {
  cats(): unknown[];
  cat(id: unknown): IssuanceCat[];
}
interface IssuancePendingSpend {
  coin(): IssuanceCoin;
  p2PuzzleHash(): Uint8Array;
  conditions(): unknown[];
}
interface IssuanceFinished {
  pendingSpends(): IssuancePendingSpend[];
  insert(coinId: Uint8Array, spend: unknown): void;
  spend(): IssuanceOutputs;
}
interface IssuanceSpends {
  addXch(coin: unknown): void;
  apply(actions: unknown[]): unknown;
  prepare(deltas: unknown): IssuanceFinished;
}
interface IssuanceProgram {
  curry(args: IssuanceProgram[]): IssuanceProgram;
}
interface IssuanceClvm {
  alloc(value: unknown): IssuanceProgram;
  nil(): IssuanceProgram;
  everythingWithSignature(): IssuanceProgram;
  standardSpend(syntheticKey: unknown, spend: unknown): unknown;
  delegatedSpend(conditions: unknown[]): unknown;
  coinSpends(): SigCoinSpend[];
}

/** The full wasm surface CAT issuance needs (standalone, like `NftWasm`/`DidWasm`). */
export interface CatIssuanceWasm {
  toHex(bytes: Uint8Array): string;
  fromHex(hex: string): Uint8Array;
  Clvm: new () => IssuanceClvm;
  Spends: new (clvm: IssuanceClvm, changePuzzleHash: Uint8Array) => IssuanceSpends;
  Spend: new (puzzle: unknown, solution: unknown) => unknown;
  Action: {
    singleIssueCat(hiddenPuzzleHash: Uint8Array | undefined, amount: bigint): unknown;
    issueCat(tailSpend: unknown, hiddenPuzzleHash: Uint8Array | undefined, amount: bigint): unknown;
    fee(amount: bigint): unknown;
  };
  // Derivation surface reused via a cast to SendFlowWasm.
  SecretKey: unknown;
}

const asHex = (chia: CatIssuanceWasm, b: Uint8Array): string => strip0x(chia.toHex(b));

/** The chain surface CAT issuance needs — the standard {@link ChainClient} (funding coins only). */
export type CatIssuanceChain = ChainClient;

/** Which TAIL shape to issue under — see the module doc for the on-chain difference. */
export type CatIssuanceMode = 'single' | 'multi';

/** A prepared (unsigned) CAT issuance: coin spends + the keys to sign + the decoded summary. */
export interface PreparedCatIssuance {
  coinSpends: SigCoinSpend[];
  secretKeys: SigSecretKey[];
  /** The newly-minted asset id (hex) — the CAT's stable on-chain identity once broadcast. */
  assetId: string;
  summary: CatIssuanceSummary;
}
/** The decoded, tamper-resistant summary of a CAT issuance for the user to approve. */
export interface CatIssuanceSummary {
  assetId: string;
  mode: CatIssuanceMode;
  /** The minted supply, in base units (decimal string). */
  amount: string;
  fee: string;
  coinCount: number;
}

/**
 * Prepare (build, don't sign/broadcast) the ISSUANCE of a brand-new CAT owned by this wallet (#97).
 * `mode: 'single'` (default) issues a fixed-supply, genesis-by-coin-id TAIL (can never be re-minted).
 * `mode: 'multi'` issues an "everything with signature" TAIL curried with this wallet's OWN synthetic
 * public key at the active index, so it — and only it — can authorize a future re-mint/melt. The
 * minted supply + any XCH change return to this wallet (index-0). Throws `NO_XCH_COINS` when the
 * wallet holds no XCH to fund the issuance spend, `BAD_REQUEST` for a non-positive amount.
 */
export async function prepareCatIssuance(
  chia: CatIssuanceWasm,
  chain: CatIssuanceChain,
  opts: { seed: Uint8Array; amount: bigint; mode?: CatIssuanceMode; fee?: bigint; activeIndex?: number },
): Promise<PreparedCatIssuance> {
  if (opts.amount <= 0n) throw new Error('BAD_REQUEST: the minted amount must be positive');
  const mode = opts.mode ?? 'single';
  const fee = opts.fee ?? 0n;
  const keyring = buildKeyring(chia as unknown as SendFlowWasm, opts.seed, { index: opts.activeIndex ?? 0 });
  const keyByPuzzleHash = new Map(keyring.map((k) => [k.puzzleHashHex, k]));

  const xchCoins = await chain.unspentCoins(keyring.map((k) => k.puzzleHashHex));
  if (xchCoins.length === 0) throw new Error('NO_XCH_COINS: the wallet has no XCH to fund the issuance');

  const clvm = new chia.Clvm();
  const changePuzzleHash = chia.fromHex(keyring[0].puzzleHashHex); // new CAT + change go here (self)
  const spends = new chia.Spends(clvm, changePuzzleHash);
  for (const c of xchCoins) spends.addXch(c);

  const actions: unknown[] = [];
  if (mode === 'single') {
    actions.push(chia.Action.singleIssueCat(undefined, opts.amount));
  } else {
    // Multi-issuance: curry the standard "everything with signature" TAIL with this wallet's own
    // synthetic pubkey (index-0) — the SAME key `signing.ts` already knows how to sign for, since the
    // TAIL's AGG_SIG_ME condition surfaces through the normal puzzle-run condition scan.
    const pubkeyBytes = (keyring[0].pk as unknown as { toBytes(): Uint8Array }).toBytes();
    const tailPuzzle = clvm.everythingWithSignature().curry([clvm.alloc(pubkeyBytes)]);
    const tailSpend = new chia.Spend(tailPuzzle, clvm.nil());
    actions.push(chia.Action.issueCat(tailSpend, undefined, opts.amount));
  }
  if (fee > 0n) actions.push(chia.Action.fee(fee));

  const finished = spends.prepare(spends.apply(actions));
  for (const ps of finished.pendingSpends()) {
    const key = keyByPuzzleHash.get(asHex(chia, ps.p2PuzzleHash()));
    if (!key) throw new Error('MISSING_KEY: a funding coin is not owned by this wallet');
    finished.insert(ps.coin().coinId(), clvm.standardSpend(key.pk, clvm.delegatedSpend(ps.conditions())));
  }
  const outputs = finished.spend();
  const newCatIds = outputs.cats();
  if (newCatIds.length === 0) throw new Error('ISSUANCE_FAILED: no CAT was created by this spend');
  const minted = outputs.cat(newCatIds[0]);
  if (minted.length === 0) throw new Error('ISSUANCE_FAILED: the minted CAT coin could not be resolved');
  const assetId = asHex(chia, minted[0].info.assetId);

  const coinSpends = clvm.coinSpends();
  return {
    coinSpends,
    secretKeys: keyring.map((k) => k.sk),
    assetId,
    summary: { assetId, mode, amount: opts.amount.toString(), fee: fee.toString(), coinCount: coinSpends.length },
  };
}
