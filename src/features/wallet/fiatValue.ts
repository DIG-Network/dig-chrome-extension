/**
 * The fiat-conversion display resolver (#112) — turns an already-known USD amount into the user's
 * chosen display currency, respecting the four-state rule (#158): a KNOWN rate converts, a rate
 * still IN FLIGHT is `loading` (never the word "unavailable" mid-fetch), and a rate that genuinely
 * couldn't be obtained gracefully DEGRADES to the USD amount — the wallet always shows a real,
 * honest number, worst case in the native price-anchor currency instead of the user's pick. This is
 * a leaf (no DOM / chrome.* / intl dependency), same idiom as `balanceUnit.ts`/`portfolioValue.ts`.
 *
 * NOTE: this only decides the CURRENCY conversion. Whether a USD amount is known AT ALL (balance/
 * price loading vs. genuinely unpriced) is a separate, upstream concern already handled by
 * `assetUsdValue`/`portfolioValue`/`AssetRow`'s `priceLoading` — callers only invoke this once `usd`
 * is non-null.
 */

import type { FiatCode } from './fiatCurrency';
import type { FxRateMap } from './fxRates';

export type FiatValueState =
  | { kind: 'value'; amount: number; currency: FiatCode }
  | { kind: 'loading' };

/**
 * Resolve the display amount + currency for an already-known `usd` value.
 *  - `fiat === 'usd'` → passthrough, no rate needed.
 *  - a known, finite, positive rate for `fiat` → convert (`usd × rate`).
 *  - no rate yet AND `fxLoading` → `{ kind: 'loading' }` (render a skeleton, never "unavailable").
 *  - no rate and NOT loading (a genuinely failed/incomplete fetch) → fall back to the USD amount.
 */
export function resolveFiatValue(params: {
  usd: number;
  fiat: FiatCode;
  fxRates: FxRateMap | undefined;
  fxLoading: boolean;
}): FiatValueState {
  const { usd, fiat, fxRates, fxLoading } = params;
  if (fiat === 'usd') return { kind: 'value', amount: usd, currency: 'usd' };

  const rate = fxRates?.[fiat];
  if (rate != null && Number.isFinite(rate) && rate > 0) {
    return { kind: 'value', amount: usd * rate, currency: fiat };
  }
  if (fxLoading) return { kind: 'loading' };
  return { kind: 'value', amount: usd, currency: 'usd' };
}
