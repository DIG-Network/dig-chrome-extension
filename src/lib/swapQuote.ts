/**
 * Token swap quoting (#103, extension-parity P2) — a pure best-rate SELECTOR over dexie's public
 * offer book, NOT an AMM: "swap" here means "take the best currently-open offer that pays out what
 * you want for what you're giving," exactly the TibetSwap/dexie market-order UX pattern, built with
 * NO new wasm beyond what NFT/multi-asset offers already ships (§103's own scoping note). Quoting is
 * a client-side pick over `searchDexieOffers`'s (already-existing, #102) results — DISPLAY amounts
 * only, per `dexie.ts`'s module doc (dexie normalizes to human-decimal). The actual swap EXECUTION
 * never trusts this module's numbers: it re-derives the real base-unit amounts from the raw
 * `offer1…` bytes via the existing `inspectOffer`/`prepareTrade`/`confirmTrade` take pipeline — this
 * module only picks WHICH offer to take.
 */

import type { DexieAsset, DexieOfferSummary } from '@/lib/dexie';

/** A quoted swap: the best open offer matching `sellCode → buyCode`, in dexie's display units. */
export interface SwapQuote {
  /** The dexie offer id — informational only (the executed take re-derives from `offerStr`). */
  dexieId: string;
  /** The raw `offer1…` bytes to feed the existing take pipeline. */
  offerStr: string;
  /** The matched leg's OWN dexie-reported ticker (e.g. `'DBX'`) — friendly for display even when
   * the caller searched by a raw CAT asset id. */
  sellCode: string;
  /** How much of `sellCode` this specific offer asks for (dexie display units). */
  sellAmount: number;
  buyCode: string;
  /** How much of `buyCode` this specific offer pays out (dexie display units). */
  buyAmount: number;
  /** `buyAmount` per 1 unit of `sellAmount` — the effective exchange rate of this offer. */
  rate: number;
}

/** dexie's "open" status code (see `dexie.ts`'s module doc — 0 open, everything else is not tradeable). */
const DEXIE_STATUS_OPEN = 0;

/** True if a dexie asset entry identifies `code` — matched against EITHER its `code` or its `id` (a
 * CAT's asset id), case-insensitively, since callers may hand either the ticker or the raw asset id. */
function assetMatches(asset: DexieAsset, code: string): boolean {
  const wanted = code.trim().toLowerCase();
  return asset.code.toLowerCase() === wanted || asset.id.toLowerCase() === wanted;
}

/**
 * Pick the BEST-RATE open offer that pays out `buyCode` in exchange for `sellCode`, from a list of
 * dexie search results (the caller already filtered the search by `offered=buyCode&requested=
 * sellCode`; this re-checks defensively so a stale/mismatched candidate list can't slip through).
 * "Best" = the highest `buyAmount / sellAmount` ratio — the most `buyCode` per unit of `sellCode`
 * given up. Returns `null` when no candidate matches (an empty book, or `sellCode === buyCode`).
 *
 * `desiredSellAmount` (#484 — the swap container's amount-to-swap input) is an OPTIONAL ceiling on
 * how much of `sellCode` the caller is willing to give up, in the SAME human-decimal units dexie
 * itself reports (matches `sellLeg.amount`'s convention — no base-unit conversion needed here). A
 * dexie offer is all-or-nothing (this wallet's take pipeline can't partial-fill one), so sizing
 * works by FILTERING candidates to ones that fit the ceiling (`sellLeg.amount <= desiredSellAmount`)
 * and picking the best rate among THOSE — never a global best-rate offer the caller can't/won't
 * afford. Omitted, `0`, or negative means "no ceiling" (the original unconstrained best-rate pick,
 * preserved for back-compat with every existing 3-arg call site).
 */
export function bestSwapQuote(offers: DexieOfferSummary[], sellCode: string, buyCode: string, desiredSellAmount?: number): SwapQuote | null {
  if (sellCode.trim().toLowerCase() === buyCode.trim().toLowerCase()) return null;
  const ceiling = desiredSellAmount != null && desiredSellAmount > 0 ? desiredSellAmount : null;
  let best: SwapQuote | null = null;
  for (const offer of offers) {
    if (offer.status !== DEXIE_STATUS_OPEN) continue;
    const sellLeg = offer.requested.find((a) => assetMatches(a, sellCode));
    const buyLeg = offer.offered.find((a) => assetMatches(a, buyCode));
    if (!sellLeg || !buyLeg || sellLeg.amount <= 0 || buyLeg.amount <= 0) continue;
    if (ceiling != null && sellLeg.amount > ceiling) continue; // doesn't fit the entered amount
    const rate = buyLeg.amount / sellLeg.amount;
    if (!best || rate > best.rate) {
      // Display the matched leg's OWN dexie-reported ticker (`sellLeg.code`/`buyLeg.code`), not the
      // raw search string — a caller searching by a CAT's asset id still sees a friendly ticker.
      best = { dexieId: offer.id, offerStr: offer.offerStr, sellCode: sellLeg.code, sellAmount: sellLeg.amount, buyCode: buyLeg.code, buyAmount: buyLeg.amount, rate };
    }
  }
  return best;
}

/** Result of {@link validateSwapAmount}: `ok` + (on failure) an i18n message id for the inline error. */
export interface SwapAmountValidation {
  ok: boolean;
  error?: string;
}

/**
 * Validate the swap container's "amount to swap" input (#484) — the quantity of the SOURCE
 * (sell) asset the user wants to give up. Three checks, in order:
 *   1. numeric + strictly positive (blank gets its own message so the field doesn't open on an
 *      "invalid" error before the user has typed anything);
 *   2. no more fractional digits than `decimals` supports — a CAT/XCH base-unit amount can't
 *      represent extra precision, so this REJECTS rather than silently rounding to a different
 *      amount than what's displayed;
 *   3. does not exceed `spendable` (the wallet's own balance for that asset, in base units) — a
 *      `null`/unknown balance is treated as insufficient (fail-closed), never a false pass.
 * Pure (no DOM/chrome.*), so every branch is unit-tested independent of the panel.
 */
export function validateSwapAmount(amount: string, decimals: number, spendable: number | null): SwapAmountValidation {
  const trimmed = amount.trim();
  if (trimmed === '') return { ok: false, error: 'swap.amount.error.required' };
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return { ok: false, error: 'swap.amount.error.invalid' };
  const dot = trimmed.indexOf('.');
  if (dot !== -1 && trimmed.length - dot - 1 > decimals) {
    return { ok: false, error: 'swap.amount.error.precision' };
  }
  const base = Math.round(n * 10 ** decimals);
  if (spendable == null || base > spendable) {
    return { ok: false, error: 'swap.amount.error.insufficientBalance' };
  }
  return { ok: true };
}

/** The dexie search "code" for a wallet asset: `'XCH'` for native XCH, else the CAT asset id (hex). */
export function dexieCodeOf(asset: { kind: 'xch' } | { kind: 'cat'; assetId: string }): string {
  return asset.kind === 'xch' ? 'XCH' : asset.assetId;
}
