/**
 * Chia clawback (CHIP-0035-adjacent CLVM primitive, #152) — send funds into a timelocked reclaim
 * puzzle with a hard cutover at `seconds` (an ABSOLUTE unix timestamp), proven against the wasm
 * Simulator (`clawback.test.ts`): STRICTLY BEFORE `seconds` only the SENDER can spend it (claw back —
 * `ASSERT_BEFORE_SECONDS_ABSOLUTE` gates `senderSpend`); AT/AFTER `seconds` only the RECEIVER can
 * (claim — `ASSERT_SECONDS_ABSOLUTE` gates `receiverSpend`). There is no overlap window where both
 * paths are simultaneously valid — the sender's safety window IS "before the deadline", which is
 * automatically "before the receiver could possibly claim" (they are locked out until then). Built on
 * `chia-wallet-sdk-wasm`'s `ClawbackV2` — the SAME construction Sage uses
 * (`xch-dev/sage` `crates/sage-wallet/src/wallet/xch.rs` + `child_kind.rs`): the locked coin's
 * puzzle hash is `ClawbackV2.puzzleHash()`; its CREATE_COIN carries `[receiverPuzzleHash,
 * clawback.memo()]` as memos so the receiver's wallet discovers it by hint (coinset
 * `get_coin_records_by_hints`) and reconstructs the params via `ClawbackV2.fromMemo` (which also
 * verifies the reconstruction against the coin's actual on-chain puzzle hash — a coin merely
 * mentioning our address in an unrelated memo is rejected, never trusted blind).
 *
 * Send-with-clawback reuses the ordinary `sendFlow.prepareXchSend` (its `clawbackSeconds` option) —
 * building the locked coin is just a send to a different puzzle hash with extra memos, spent from the
 * wallet's OWN coins exactly like a plain send. This module owns what's DIFFERENT: discovering a
 * pending clawback coin (this file) and building the CLAIM (receiver) / CLAW BACK (sender) spend that
 * consumes it — `Clvm.spendCoin` directly (not the `Spends`/`Action` driver: there is exactly one,
 * already-known coin and puzzle to spend, no coin selection needed). Both spends carry a normal
 * AGG_SIG_ME under the actor's own synthetic key (embedded by `ClawbackV2.senderSpend`/
 * `.receiverSpend` wrapping a `standardSpend`), so they sign via the SAME generic
 * `signing.ts`/`sendFlow.signAndBundle` used everywhere else — no bespoke signing path.
 *
 * XCH only (v1, #152) — CAT clawback (`hinted: true`) is a documented follow-up (SPEC.md § Clawback).
 * Never broadcasts; proven consensus-valid + timelock-enforced against the wasm Simulator
 * (`clawback.test.ts`). Runs in the offscreen vault (holds the seed).
 */

import type { KeyringEntry } from '@/offscreen/sendFlow';
import type { SigCoinSpend, SigSecretKey } from '@/offscreen/signing';
import type { ChainClient, ChainCoin } from '@/offscreen/chain';

const strip0x = (h: string): string => h.replace(/^0x/i, '').toLowerCase();
/** CLVM max cost when running a parent puzzle to read its CREATE_COIN + memos (matches send.ts/signing.ts). */
const MAX_COST = 11_000_000_000n;

// ── Minimal structural surfaces of the wasm objects this module touches ──────────────────────────
interface CbPublicKey {
  toBytes(): Uint8Array;
}
interface CbCreateCoin {
  puzzleHash: Uint8Array;
  amount: bigint;
  memos?: CbProgram;
}
interface CbProgram {
  toAtom(): Uint8Array | undefined;
  toList(): CbProgram[] | undefined;
  parseCreateCoin(): CbCreateCoin | undefined;
  run(solution: CbProgram, maxCost: bigint, mempoolMode: boolean): { value: CbProgram };
}
interface CbSpend {
  free?(): void;
}
export interface CbCoin {
  coinId(): Uint8Array;
  parentCoinInfo: Uint8Array;
  puzzleHash: Uint8Array;
  amount: bigint;
}
interface CbClvm {
  deserialize(bytes: Uint8Array): CbProgram;
  atom(value: Uint8Array): CbProgram;
  list(value: CbProgram[]): CbProgram;
  createCoin(puzzleHash: Uint8Array, amount: bigint, memos?: CbProgram): CbProgram;
  reserveFee(amount: bigint): CbProgram;
  delegatedSpend(conditions: CbProgram[]): CbSpend;
  standardSpend(syntheticKey: CbPublicKey, spend: CbSpend): CbSpend;
  spendCoin(coin: CbCoin, spend: CbSpend): void;
  coinSpends(): SigCoinSpend[];
}
export interface CbClawbackV2 {
  senderPuzzleHash: Uint8Array;
  receiverPuzzleHash: Uint8Array;
  seconds: bigint;
  amount: bigint;
  hinted: boolean;
  senderSpend(spend: CbSpend): CbSpend;
  receiverSpend(spend: CbSpend): CbSpend;
  puzzleHash(): Uint8Array;
  memo(clvm: CbClvm): CbProgram;
  free?(): void;
}
/** The `chia-wallet-sdk-wasm` surface this module needs. `ClawbackV2` has a REAL public constructor
 * (confirmed against the generated `.d.ts` — unlike the `RpcClient.new(...)`-only factory pattern,
 * #148) so `new chia.ClawbackV2(...)` is safe here. */
export interface ClawbackWasm {
  toHex(bytes: Uint8Array): string;
  fromHex(hex: string): Uint8Array;
  Clvm: new () => CbClvm;
  ClawbackV2: {
    new (senderPuzzleHash: Uint8Array, receiverPuzzleHash: Uint8Array, seconds: bigint, amount: bigint, hinted: boolean): CbClawbackV2;
    fromMemo(memo: CbProgram, receiverPuzzleHash: Uint8Array, amount: bigint, hinted: boolean, expectedPuzzleHash: Uint8Array): CbClawbackV2 | undefined;
  };
}

/**
 * The on-chain clawback parameters for ONE locked coin — enough to recompute its puzzle hash and, for
 * the owning actor, build the claim/claw-back spend. `seconds` is an ABSOLUTE unix timestamp (the
 * on-chain `ASSERT_SECONDS_ABSOLUTE` the receiver path enforces), NOT a duration — a send-with-
 * clawback UI computes it as `now + chosenWindowSeconds` once, at build time.
 */
export interface ClawbackInfo {
  senderPuzzleHashHex: string;
  receiverPuzzleHashHex: string;
  seconds: bigint;
  amount: bigint;
}

/** Build the `ClawbackV2` value for one set of params (pure — no chain/clvm dependency; a plain
 * data struct on the Rust side, matching Sage's `ClawbackV2 { sender_puzzle_hash, ... }` literal). */
function clawbackOf(chia: ClawbackWasm, info: ClawbackInfo): CbClawbackV2 {
  return new chia.ClawbackV2(chia.fromHex(info.senderPuzzleHashHex), chia.fromHex(info.receiverPuzzleHashHex), info.seconds, info.amount, false);
}

/** The locked coin's on-chain puzzle hash (hex, no `0x`) for the given clawback params. */
export function clawbackPuzzleHashHex(chia: ClawbackWasm, info: ClawbackInfo): string {
  const cb = clawbackOf(chia, info);
  const hex = strip0x(chia.toHex(cb.puzzleHash()));
  cb.free?.();
  return hex;
}

/**
 * The destination puzzle hash + a memo-builder for a send-with-clawback CREATE_COIN. The memos are
 * `[receiverPuzzleHash, clawback.memo()]` (matches Sage's `wallet/memos.rs::calculate_memos`'s
 * `Hint::Clawback` branch) and MUST be built against the SAME `clvm` instance the send driver
 * allocates internally — a wasm `Program` is bound to its originating `Clvm`'s allocator, so building
 * it against a different instance would dangle. `send.ts`'s `buildXchSend` calls `buildMemos` with
 * its own internal `clvm` for exactly this reason.
 */
export function clawbackDestination(chia: ClawbackWasm, info: ClawbackInfo): { puzzleHash: Uint8Array; buildMemos: (clvm: unknown) => unknown } {
  const cb = clawbackOf(chia, info);
  const puzzleHash = cb.puzzleHash();
  const buildMemos = (clvm: unknown): unknown => {
    const c = clvm as CbClvm;
    return c.list([c.atom(cb.receiverPuzzleHash), cb.memo(c)]);
  };
  return { puzzleHash, buildMemos };
}

/**
 * The locked coin currently on-chain for these clawback params, or `null` if it isn't (yet) confirmed
 * or has already been claimed/reclaimed (spent) — `chain.unspentCoins` returns UNSPENT coins only, and
 * the clawback puzzle hash is unique per (sender, receiver, seconds, amount) tuple.
 */
export async function findClawbackCoin(chia: ClawbackWasm, chain: ChainClient, info: ClawbackInfo): Promise<ChainCoin | null> {
  const ph = clawbackPuzzleHashHex(chia, info);
  const coins = await chain.unspentCoins([ph]);
  return coins.find((c) => c.amount === info.amount) ?? coins[0] ?? null;
}

/** One discovered INCOMING pending clawback: the live locked coin + its reconstructed params. */
export interface PendingClawback {
  coin: ChainCoin;
  info: ClawbackInfo;
}

/**
 * Discover INCOMING pending clawbacks — coins hinted to one of the wallet's OWN puzzle hashes (the
 * memo's first entry is always the receiver's puzzle hash, matching Sage's `child_kind.rs`
 * `parse_clawback_unchecked`) whose reconstructed `ClawbackV2` verifies against the coin's own puzzle
 * hash (`ClawbackV2.fromMemo`'s built-in tamper check — a coin that merely mentions our address in an
 * unrelated memo, or a forged memo, is silently skipped, never trusted blind). For each hinted
 * candidate, fetches its PARENT's spend (the memo lives on the PARENT's CREATE_COIN condition, not on
 * the coin itself — exactly parallel to `sendFlow.reconstructCats`'s CAT-lineage reconstruction).
 * Requires `chain.coinsByHints`; throws `HINT_LOOKUP_UNAVAILABLE` if the chain client lacks it.
 */
export async function discoverIncomingClawbacks(chia: ClawbackWasm, chain: ChainClient, keyring: KeyringEntry[]): Promise<PendingClawback[]> {
  if (!chain.coinsByHints) throw new Error('HINT_LOOKUP_UNAVAILABLE: the chain client cannot resolve hints');
  const ownPhs = new Set(keyring.map((k) => k.puzzleHashHex));
  const hinted = await chain.coinsByHints([...ownPhs]);
  const out: PendingClawback[] = [];
  for (const coin of hinted) {
    const parentHex = strip0x(chia.toHex(coin.parentCoinInfo));
    const parentSpend = await chain.getCoinSpend(parentHex);
    if (!parentSpend) continue;
    const clvm = new chia.Clvm();
    const puzzle = clvm.deserialize(parentSpend.puzzleReveal);
    const solution = clvm.deserialize(parentSpend.solution);
    const conditions = puzzle.run(solution, MAX_COST, false).value.toList() ?? [];
    const wantedCoinIdHex = strip0x(chia.toHex(coin.coinId()));
    for (const cond of conditions) {
      const cc = cond.parseCreateCoin();
      if (!cc || !cc.memos) continue;
      // Confirm this CREATE_COIN is the one that actually produced `coin` (id = hash(parent, ph, amount)).
      if (strip0x(chia.toHex(cc.puzzleHash)) !== strip0x(chia.toHex(coin.puzzleHash)) || cc.amount !== coin.amount) continue;
      const memoList = cc.memos.toList();
      if (!memoList || memoList.length < 2) continue;
      const receiverPh = memoList[0].toAtom();
      if (!receiverPh || !ownPhs.has(strip0x(chia.toHex(receiverPh)))) continue;
      const cb = chia.ClawbackV2.fromMemo(memoList[1], receiverPh, cc.amount, false, cc.puzzleHash);
      if (!cb) continue;
      out.push({
        coin,
        info: {
          senderPuzzleHashHex: strip0x(chia.toHex(cb.senderPuzzleHash)),
          receiverPuzzleHashHex: strip0x(chia.toHex(cb.receiverPuzzleHash)),
          seconds: cb.seconds,
          amount: cb.amount,
        },
      });
      break; // this coin can only have been created by ONE CREATE_COIN condition
    }
    void wantedCoinIdHex; // kept for clarity of intent above; matching is by (puzzleHash, amount)
  }
  return out;
}

/** A built (unsigned) CLAIM/CLAW-BACK spend, ready for `sendFlow.signAndBundle`. */
export interface PreparedClawbackAction {
  coinSpends: SigCoinSpend[];
  secretKeys: SigSecretKey[];
  info: ClawbackInfo;
  /** The amount actually delivered to the actor's own address (== `info.amount - fee`). */
  amountOut: bigint;
}

/**
 * Build the CLAIM (receiver) or CLAW BACK (sender) spend for one locked clawback coin. The actor's
 * OWN key must be present in `keyring` for the relevant side (`receiverPuzzleHashHex` for claim,
 * `senderPuzzleHashHex` for reclaim) — throws `MISSING_KEY` otherwise (you can only claim a clawback
 * sent TO one of your own addresses, or reclaim one you sent FROM one of them). Does NOT itself check
 * `info.seconds` against wall-clock time (that's a UI convenience only) — the ON-CHAIN puzzle is the
 * enforcement: a claim broadcast before `seconds`, or a reclaim broadcast at/after it, is rejected by
 * consensus (`AssertSecondsAbsoluteFailed`/`AssertBeforeSecondsAbsoluteFailed`) when pushed. Moves the
 * coin's full
 * amount minus `fee` to the actor's OWN standard puzzle hash (self — a claim/reclaim returns funds to
 * the wallet's ordinary balance, never to a third party), reserving the fee out of the same coin (no
 * extra input coin needed). Fetches the coin live via {@link findClawbackCoin} (throws
 * `NO_CLAWBACK_COIN` if it is not currently pending — already resolved, or not yet confirmed on
 * chain). Does NOT sign or broadcast — `sendFlow.signAndBundle` signs the result exactly like any
 * other prepared spend (a normal AGG_SIG_ME under the actor's synthetic key, embedded by
 * `senderSpend`/`receiverSpend`'s wrapped `standardSpend`).
 */
export async function prepareClawbackAction(
  chia: ClawbackWasm,
  chain: ChainClient,
  opts: { keyring: KeyringEntry[]; info: ClawbackInfo; direction: 'claim' | 'reclaim'; fee: bigint },
): Promise<PreparedClawbackAction> {
  if (opts.fee > opts.info.amount) throw new Error('BAD_REQUEST: fee exceeds the clawback amount');
  const coin = await findClawbackCoin(chia, chain, opts.info);
  if (!coin) throw new Error('NO_CLAWBACK_COIN: this clawback coin is not currently pending (already resolved, or not yet confirmed)');

  const actorPhHex = opts.direction === 'claim' ? opts.info.receiverPuzzleHashHex : opts.info.senderPuzzleHashHex;
  const actor = opts.keyring.find((k) => k.puzzleHashHex === actorPhHex);
  if (!actor) {
    const side = opts.direction === 'claim' ? 'receiver' : 'sender';
    throw new Error(`MISSING_KEY: this wallet does not own the ${side} address for this clawback`);
  }

  const cb = clawbackOf(chia, opts.info);
  const clvm = new chia.Clvm();
  const amountOut = opts.info.amount - opts.fee;
  const conditions: CbProgram[] = [clvm.createCoin(chia.fromHex(actorPhHex), amountOut, undefined)];
  if (opts.fee > 0n) conditions.push(clvm.reserveFee(opts.fee));
  const inner = clvm.standardSpend(actor.pk as unknown as CbPublicKey, clvm.delegatedSpend(conditions));
  const outer = opts.direction === 'claim' ? cb.receiverSpend(inner) : cb.senderSpend(inner);
  clvm.spendCoin(coin as unknown as CbCoin, outer);
  const coinSpends = clvm.coinSpends();
  return { coinSpends, secretKeys: [actor.sk], info: opts.info, amountOut };
}
