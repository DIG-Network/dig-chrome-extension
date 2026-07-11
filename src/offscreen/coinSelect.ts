/**
 * Capped, high-value-first coin selection for spends (#417) — the pure seam every send routes through
 * so a fragmented wallet fails LOUDLY and recoverably instead of overshooting the Chia block-cost coin
 * limit. Mirrors the hub's `coin-select.ts` (epic #410/#416): the chip35 wasm `selectCoins` (descending
 * amount, tie-broken by coin id, at most `cap` coins) is INJECTED as `select`, so this stays pure —
 * no wasm chunk, no networking — and unit-tests DOM-free.
 *
 * chip35 `selectCoins` returns a discriminated result; the two failure arms become the two typed
 * errors the send layer throws so the vault's `handle` catch extracts a leading `CODE:` from the
 * message (`NEEDS_CONSOLIDATION` — enough value exists but reaching the target needs more than `cap`
 * coins, so combine then retry; `INSUFFICIENT_FUNDS` — the total is genuinely below the target).
 */

import type { Coin, PaymentAsset, SelectCoinsResult } from '@dignetwork/chip35-dl-coin-wasm';

/** The hard coin-count cap: at most this many coins may fund one spend (Chia block-cost ceiling). */
export const COIN_CAP = 50;

/** The injected chip35 selector (the real wasm `selectCoins` in production; a fake in tests). */
export type SelectCoinsFn = (coins: Coin[], target: bigint, asset: PaymentAsset, cap?: number | null) => SelectCoinsResult;

/** The accounting behind a capped-selection failure — carried by both typed errors. */
export interface ConsolidationInfo {
  asset: PaymentAsset;
  availableCoinCount: number;
  availableTotal: bigint;
  required: bigint;
  cap: number;
  needsConsolidation: boolean;
}

/**
 * Enough total value EXISTS but reaching the target needs MORE than `cap` coins (the wallet is
 * coin-fragmented). Recoverable: combine the smallest coins into one, then re-select. The message
 * begins with the `NEEDS_CONSOLIDATION:` code token so the vault surfaces `code:'NEEDS_CONSOLIDATION'`.
 */
export class NeedsConsolidationError extends Error {
  readonly info: ConsolidationInfo;
  constructor(info: ConsolidationInfo) {
    super(
      `NEEDS_CONSOLIDATION: ${info.availableCoinCount} coins hold enough but only the largest ${info.cap} ` +
        `can be spent at once; combine some coins and retry.`,
    );
    this.name = 'NeedsConsolidationError';
    this.info = { ...info, needsConsolidation: true };
  }
}

/** The wallet's TOTAL value is genuinely below the target — no consolidation helps; acquire more. */
export class InsufficientFundsError extends Error {
  readonly info: ConsolidationInfo;
  constructor(info: ConsolidationInfo) {
    super(`INSUFFICIENT_FUNDS: need ${info.required} but only ${info.availableTotal} is available.`);
    this.name = 'InsufficientFundsError';
    this.info = { ...info, needsConsolidation: false };
  }
}

/** True iff `e` is the recoverable "too many small coins" signal (drives the consolidate modal). */
export function isNeedsConsolidationError(e: unknown): e is NeedsConsolidationError {
  return e instanceof NeedsConsolidationError;
}

/** True iff `e` is the terminal "get more funds" signal. */
export function isInsufficientFundsError(e: unknown): e is InsufficientFundsError {
  return e instanceof InsufficientFundsError;
}

function bytesToHex(b: Uint8Array): string {
  let out = '';
  for (const byte of b) out += byte.toString(16).padStart(2, '0');
  return out;
}

/** A stable, order-independent key for a coin identity (lowercase hex of the three fields). */
function coinKey(c: Coin): string {
  return `${bytesToHex(c.parentCoinInfo)}:${bytesToHex(c.puzzleHash)}:${c.amount.toString()}`;
}

/** What {@link selectSpendCoins} returns on success: the chosen candidates + the accounting. */
export interface SelectSpendCoinsResult<C> {
  /** The selected candidates, largest-first (`selected[0]` is the lead coin builders expect). */
  selected: C[];
  total: bigint;
  change: bigint;
}

export interface SelectSpendCoinsArgs<C> {
  /** The full candidate set (owner/lineage-bearing objects the caller builds the spend from). */
  candidates: C[];
  /** The amount (base units / mojos) the spend must cover. */
  target: bigint;
  /** Which asset this spend settles in (`{ xch:true }` or `{ assetId }`). */
  asset: PaymentAsset;
  /** Map a candidate to its on-chain coin identity (for the wasm + for matching the result back). */
  coinOf: (candidate: C) => Coin;
  /** The injected chip35 selector. */
  select: SelectCoinsFn;
  /** Coin-count cap; defaults to {@link COIN_CAP} (50). */
  cap?: number;
}

/**
 * Select coins for a spend: high-value-first, capped, via the injected chip35 selector.
 *
 * - Ok → returns the chosen candidate objects (mapped back from the wasm coin identities) + totals.
 * - `{ ok:false, needsConsolidation:true }` → throws {@link NeedsConsolidationError}.
 * - `{ ok:false, needsConsolidation:false }` → throws {@link InsufficientFundsError}.
 */
export function selectSpendCoins<C>({ candidates, target, asset, coinOf, select, cap = COIN_CAP }: SelectSpendCoinsArgs<C>): SelectSpendCoinsResult<C> {
  const coins = candidates.map(coinOf);
  const result = select(coins, target, asset, cap);

  if (!result.ok) {
    const info: ConsolidationInfo = {
      asset,
      availableCoinCount: result.availableCoinCount,
      availableTotal: BigInt(result.availableTotal),
      required: BigInt(result.required),
      cap: result.cap,
      needsConsolidation: result.needsConsolidation,
    };
    if (result.needsConsolidation) throw new NeedsConsolidationError(info);
    throw new InsufficientFundsError(info);
  }

  // Map the wasm-chosen coin identities back to the caller's rich candidate objects, preserving the
  // wasm's largest-first order. A candidate is consumed once so duplicate-amount coins each map to a
  // distinct candidate.
  const byKey = new Map<string, C[]>();
  for (const c of candidates) {
    const k = coinKey(coinOf(c));
    const bucket = byKey.get(k);
    if (bucket) bucket.push(c);
    else byKey.set(k, [c]);
  }
  const selected: C[] = [];
  for (const chosen of result.coins) {
    const candidate = byKey.get(coinKey(chosen))?.shift();
    if (candidate) selected.push(candidate);
  }

  return { selected, total: BigInt(result.total), change: BigInt(result.change) };
}
