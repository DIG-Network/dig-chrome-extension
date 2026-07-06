/**
 * Price model shared by the price client, the RTK Query price slice, and the portfolio selectors —
 * a leaf with no transport / chrome.* / DOM dependency so every consumer can import the shape and
 * the pure selectors stay unit-testable.
 */

/** The USD price of one asset + its optional 24h change. */
export interface AssetPrice {
  /** USD per ONE whole unit of the asset (e.g. USD per 1 XCH, per 1 $DIG). Always finite, > 0. */
  usd: number;
  /** Percent change over the last 24 hours (e.g. -3.6), or null when the source doesn't report it. */
  change24h: number | null;
}

/**
 * Prices keyed by asset key: the literal `'xch'` for the native coin, or a CAT's lowercased 64-hex
 * TAIL (asset id) for a token. A missing key means "price unavailable for that asset" — the UI then
 * renders the honest "value unavailable" line rather than a fabricated number.
 */
export type PriceMap = Record<string, AssetPrice>;
