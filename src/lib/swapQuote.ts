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
 */
export function bestSwapQuote(offers: DexieOfferSummary[], sellCode: string, buyCode: string): SwapQuote | null {
  if (sellCode.trim().toLowerCase() === buyCode.trim().toLowerCase()) return null;
  let best: SwapQuote | null = null;
  for (const offer of offers) {
    if (offer.status !== DEXIE_STATUS_OPEN) continue;
    const sellLeg = offer.requested.find((a) => assetMatches(a, sellCode));
    const buyLeg = offer.offered.find((a) => assetMatches(a, buyCode));
    if (!sellLeg || !buyLeg || sellLeg.amount <= 0 || buyLeg.amount <= 0) continue;
    const rate = buyLeg.amount / sellLeg.amount;
    if (!best || rate > best.rate) {
      // Display the matched leg's OWN dexie-reported ticker (`sellLeg.code`/`buyLeg.code`), not the
      // raw search string — a caller searching by a CAT's asset id still sees a friendly ticker.
      best = { dexieId: offer.id, offerStr: offer.offerStr, sellCode: sellLeg.code, sellAmount: sellLeg.amount, buyCode: buyLeg.code, buyAmount: buyLeg.amount, rate };
    }
  }
  return best;
}

/** The dexie search "code" for a wallet asset: `'XCH'` for native XCH, else the CAT asset id (hex). */
export function dexieCodeOf(asset: { kind: 'xch' } | { kind: 'cat'; assetId: string }): string {
  return asset.kind === 'xch' ? 'XCH' : asset.assetId;
}
