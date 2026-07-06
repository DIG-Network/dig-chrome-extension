/**
 * Price client — fetches public XCH + CAT market data and normalizes it to a `PriceMap`.
 *
 * Two public sources, combined:
 *   - **CoinGecko** `simple/price` gives XCH→USD plus its 24h change (the only clean USD anchor for
 *     the Chia ecosystem).
 *   - **dexie** v2 tickers give each CAT's price quoted IN XCH (`last_price`); a CAT's USD value is
 *     `rate × XCH-USD`. dexie does not report a clean 24h change per CAT, so CAT `change24h` is null.
 *
 * All parsing is pure + tolerant (a malformed field drops that entry, never throws), so a partial
 * upstream outage degrades gracefully: if dexie is down we still price XCH; only when the XCH anchor
 * itself is unavailable does the whole map become unavailable (CATs have no USD without it). The
 * network step is isolated in `fetchPriceMap(fetchImpl)` so it can be unit-tested with a fake fetch.
 */

import type { AssetPrice, PriceMap } from './priceTypes';
import { normalizeCatId } from '@/lib/wallet-assets';

/** CoinGecko XCH→USD + 24h change. A well-known, CORS-open public endpoint (CSP-allowed). */
export const COINGECKO_XCH_URL =
  'https://api.coingecko.com/api/v3/simple/price?ids=chia&vs_currencies=usd&include_24hr_change=true';

/** dexie v2 tickers — every CAT market, each `last_price` quoted in its `target` currency. */
export const DEXIE_TICKERS_URL = 'https://api.dexie.space/v2/prices/tickers';

/** Thrown when no usable price could be assembled (the XCH USD anchor is unavailable). */
export class PricesUnavailableError extends Error {
  constructor(message = 'Prices unavailable') {
    super(message);
    this.name = 'PricesUnavailableError';
  }
}

/** A finite, strictly-positive number from any input, else null. */
function positiveNumber(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Parse CoinGecko `simple/price?ids=chia` → the XCH price. Shape:
 * `{ chia: { usd: number, usd_24h_change?: number } }`. Returns null when there is no usable price.
 */
export function parseXchUsd(json: unknown): AssetPrice | null {
  const chia = (json as { chia?: { usd?: unknown; usd_24h_change?: unknown } } | null)?.chia;
  const usd = positiveNumber(chia?.usd);
  if (usd == null) return null;
  const chg = Number(chia?.usd_24h_change);
  return { usd, change24h: Number.isFinite(chg) ? chg : null };
}

/**
 * Parse dexie v2 tickers → a map of CAT asset id (lowercased 64-hex) → its price IN XCH. Only
 * XCH-quoted pairs with a valid id and a positive rate are kept; everything else is dropped.
 */
export function parseCatRatesXch(json: unknown): Record<string, number> {
  const tickers = (json as { tickers?: unknown } | null)?.tickers;
  const out: Record<string, number> = {};
  if (!Array.isArray(tickers)) return out;
  for (const t of tickers) {
    const row = t as { base_id?: unknown; target_id?: unknown; target_code?: unknown; last_price?: unknown };
    const quotedInXch =
      String(row.target_id ?? '').toLowerCase() === 'xch' || String(row.target_code ?? '').toUpperCase() === 'XCH';
    if (!quotedInXch) continue;
    const id = normalizeCatId(row.base_id);
    const rate = positiveNumber(row.last_price);
    if (id && rate != null) out[id] = rate;
  }
  return out;
}

/**
 * Combine an XCH price + CAT→XCH rates into a `PriceMap`. CAT USD = `rate × XCH-USD` (change
 * unknown). With no XCH anchor, CATs cannot be USD-priced, so the map is empty.
 */
export function buildPriceMap(xch: AssetPrice | null, catRatesXch: Record<string, number>): PriceMap {
  const map: PriceMap = {};
  if (!xch) return map;
  map.xch = xch;
  for (const [id, rate] of Object.entries(catRatesXch)) {
    map[id] = { usd: rate * xch.usd, change24h: null };
  }
  return map;
}

/** GET + parse JSON, throwing on a non-2xx response. */
async function fetchJson(fetchImpl: typeof fetch, url: string): Promise<unknown> {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * Fetch both sources (in parallel, each failing independently) and assemble the `PriceMap`.
 * Throws `PricesUnavailableError` only when the XCH anchor could not be obtained.
 */
export async function fetchPriceMap(fetchImpl: typeof fetch = fetch): Promise<PriceMap> {
  const [xchRes, catRes] = await Promise.allSettled([
    fetchJson(fetchImpl, COINGECKO_XCH_URL),
    fetchJson(fetchImpl, DEXIE_TICKERS_URL),
  ]);
  const xch = xchRes.status === 'fulfilled' ? parseXchUsd(xchRes.value) : null;
  const catRates = catRes.status === 'fulfilled' ? parseCatRatesXch(catRes.value) : {};
  const map = buildPriceMap(xch, catRates);
  if (Object.keys(map).length === 0) throw new PricesUnavailableError();
  return map;
}
