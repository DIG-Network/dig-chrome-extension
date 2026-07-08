/**
 * The fiat-currency display preference (#112) — lets the user pick which currency the wallet's $
 * values render in (default USD, the wallet's native price anchor — see `priceSources.ts`). A leaf
 * module (no DOM / chrome.* / intl dependency), same idiom as `balanceUnit.ts`, so the supported set
 * + persistence key are unit-tested directly.
 *
 * Every code here is a valid ISO 4217 currency code AND a CoinGecko `vs_currencies` code, so
 * `fxRates.ts` can fetch a rate for each without a translation table.
 */

/** The fiat currencies the wallet can display values in. USD is the native price-feed anchor. */
export type FiatCode = 'usd' | 'eur' | 'gbp' | 'jpy' | 'cny' | 'twd' | 'krw' | 'rub' | 'brl' | 'try' | 'vnd' | 'idr' | 'inr';

export interface FiatCurrencyMeta {
  code: FiatCode;
  /** A short display symbol/prefix shown in the currency picker (e.g. `$`, `€`, `NT$`). */
  symbol: string;
}

/** The supported set, USD first (the native anchor), otherwise ordered by rough global usage. */
export const SUPPORTED_FIAT_CURRENCIES: FiatCurrencyMeta[] = [
  { code: 'usd', symbol: '$' },
  { code: 'eur', symbol: '€' },
  { code: 'gbp', symbol: '£' },
  { code: 'jpy', symbol: '¥' },
  { code: 'cny', symbol: '¥' },
  { code: 'twd', symbol: 'NT$' },
  { code: 'krw', symbol: '₩' },
  { code: 'rub', symbol: '₽' },
  { code: 'brl', symbol: 'R$' },
  { code: 'try', symbol: '₺' },
  { code: 'vnd', symbol: '₫' },
  { code: 'idr', symbol: 'Rp' },
  { code: 'inr', symbol: '₹' },
];

/** `chrome.storage.local` key the preference persists to (read/written via `useStorageValue`). */
export const FIAT_CURRENCY_STORAGE_KEY = 'wallet.fiatCurrency';

/** The default currency for a fresh install / an unset or corrupted stored value. */
export const DEFAULT_FIAT_CURRENCY: FiatCode = 'usd';

const CODES = new Set<string>(SUPPORTED_FIAT_CURRENCIES.map((c) => c.code));

/** True when `v` is a supported `FiatCode` — guards a stored value read back from `chrome.storage`. */
export function isFiatCode(v: unknown): v is FiatCode {
  return typeof v === 'string' && CODES.has(v);
}
