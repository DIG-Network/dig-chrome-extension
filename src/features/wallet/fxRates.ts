/**
 * Fiat exchange-rate client (#112) — fetches CoinGecko's XCH price quoted in EVERY supported fiat
 * currency (one call, multiple `vs_currencies`) and derives fiat-per-USD ratios from it. This rides
 * the SAME public price feed `priceSources.ts` already uses (#28), just widened to more currencies,
 * so a CAT/XCH USD value (already computed by `portfolioValue.ts`) converts to any supported fiat by
 * a single multiply — no separate FX API, no new wasm.
 *
 * Kept as its own module (not folded into `priceSources.ts`) so the well-tested USD-anchored price
 * pipeline (`fetchPriceMap`/`buildPriceMap`, consumed by ordering + portfolio-value selectors) stays
 * completely unchanged; this is purely a DISPLAY-layer conversion table.
 */

import type { FiatCode } from './fiatCurrency';
import { SUPPORTED_FIAT_CURRENCIES } from './fiatCurrency';

/** Fiat units per 1 USD, keyed by currency code. Always includes `usd: 1` when non-empty. */
export type FxRateMap = Partial<Record<FiatCode, number>>;

/** CoinGecko `simple/price`, XCH quoted in every supported fiat currency in one call. */
export const COINGECKO_FX_URL = `https://api.coingecko.com/api/v3/simple/price?ids=chia&vs_currencies=${SUPPORTED_FIAT_CURRENCIES.map((c) => c.code).join(',')}`;

/** Thrown when no usable fiat rate table could be assembled (the USD anchor is unavailable). */
export class FxRatesUnavailableError extends Error {
  constructor(message = 'Exchange rates unavailable') {
    super(message);
    this.name = 'FxRatesUnavailableError';
  }
}

/** A finite, strictly-positive number from any input, else null. */
function positiveNumber(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Parse a CoinGecko `simple/price?ids=chia&vs_currencies=usd,eur,…` response into a fiat-per-USD
 * rate table: `rate[code] = chia[code] / chia.usd`. Returns `{}` when there is no usable USD anchor
 * (mirrors `priceSources.ts`'s "no XCH price ⇒ nothing is priceable" rule).
 */
export function parseFxRates(json: unknown): FxRateMap {
  const chia = (json as { chia?: Record<string, unknown> } | null)?.chia;
  const usd = positiveNumber(chia?.usd);
  if (usd == null) return {};
  const out: FxRateMap = { usd: 1 };
  for (const { code } of SUPPORTED_FIAT_CURRENCIES) {
    if (code === 'usd') continue;
    const v = positiveNumber(chia?.[code]);
    if (v != null) out[code] = v / usd;
  }
  return out;
}

/** Fetch + parse the fiat rate table. Throws `FxRatesUnavailableError` when nothing usable comes back. */
export async function fetchFxRates(fetchImpl: typeof fetch = fetch): Promise<FxRateMap> {
  const res = await fetchImpl(COINGECKO_FX_URL);
  if (!res.ok) throw new FxRatesUnavailableError(`HTTP ${res.status}`);
  const rates = parseFxRates(await res.json());
  if (Object.keys(rates).length === 0) throw new FxRatesUnavailableError();
  return rates;
}
