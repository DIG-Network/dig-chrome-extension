/**
 * The hero-balance display-unit preference (#156) — lets the user pick which unit is PROMINENT on
 * the Home wallet-balance widget: fiat (`usd`) or the native coin (`xch`), flipped by a swap button
 * next to the balance. A leaf module (no DOM / chrome.* / intl dependency) so the toggle + the
 * prominent/secondary layout logic are unit-tested directly; `HomeScreen.tsx` only wires the
 * persisted value (via `useStorageValue`, same idiom as `wallet.watchedCats`/`wallet.hiddenCats`
 * already used there) and the live price into this pure display computation.
 *
 * The native `xch` unit is the honest default (§ pickHeroBalance's own reasoning): it never depends
 * on a price feed, so a fresh install with no market data yet still shows a real number.
 */

/** The two units the hero balance can be shown in. */
export type BalanceUnit = 'usd' | 'xch';

/** `chrome.storage.local` key the preference persists to (read/written via `useStorageValue`). */
export const BALANCE_UNIT_STORAGE_KEY = 'wallet.homeBalanceUnit';

/** The default unit for a fresh install / an unset or corrupted stored value. */
export const DEFAULT_BALANCE_UNIT: BalanceUnit = 'xch';

/** True when `v` is a valid `BalanceUnit` — guards a stored value read back from `chrome.storage`. */
export function isBalanceUnit(v: unknown): v is BalanceUnit {
  return v === 'usd' || v === 'xch';
}

/** Flip the preference: `usd` ⇄ `xch`. */
export function toggleBalanceUnit(unit: BalanceUnit): BalanceUnit {
  return unit === 'usd' ? 'xch' : 'usd';
}

/**
 * One display slot's resolved state:
 *  - `value`  → render `text` literally (a native "amount ticker" string or a formatted USD string).
 *  - `loading` → the slot's value is still being fetched; render a skeleton/spinner (`text` is null).
 *  - `status` → `text` is a react-intl message id (render via `FormattedMessage`), e.g. an honest
 *    "price unavailable" note — reserved for a genuine failure or a completed load with no usable
 *    price, NEVER shown while a fetch is still in flight (that's `loading`).
 */
export interface SlotDisplay {
  kind: 'value' | 'loading' | 'status';
  text: string | null;
}

/** The prominent + secondary slots to render for the hero balance, given the chosen unit. */
export interface HeroDisplay {
  prominent: SlotDisplay;
  secondary: SlotDisplay;
}

/**
 * Compute the hero balance's prominent/secondary display for the chosen unit.
 *
 * The native amount (`amountLabel ticker`) is ALWAYS knowable — it never depends on price. The USD
 * conversion occupies the PROMINENT slot when `unit === 'usd'`, else the SECONDARY slot — that one
 * slot's state is derived from the RTK Query price flags, not conflated:
 *   - a price is known (`usd != null`)                       → `{ kind: 'value' }`, the real number.
 *   - no price yet, but there IS a balance to price and the
 *     price fetch is still in flight (`hasAsset && pricesLoading`) → `{ kind: 'loading' }` — a
 *     skeleton/spinner, NEVER the word "unavailable".
 *   - otherwise (an error, a completed load with no usable
 *     price, or no balance to price at all)                  → `{ kind: 'status' }`, the honest
 *     "price unavailable" message id — reserved for genuine unavailability, never shown mid-fetch.
 * The OTHER slot (the one that doesn't carry the USD conversion) never depends on price:
 * prominent is always native in `xch` mode; secondary in `usd` mode shows "≈ native" the instant
 * it's known — the balance itself never waits on the price feed.
 */
export function heroBalanceDisplay(params: {
  unit: BalanceUnit;
  amountLabel: string;
  ticker: string;
  /** The hero asset's USD value (already balance × price), or null when unknown. */
  usd: number | null;
  /** Whether there is a balance to price at all — false means "unavailable" can never become "loading". */
  hasAsset: boolean;
  pricesLoading: boolean;
  formatUsd: (n: number) => string;
}): HeroDisplay {
  const { unit, amountLabel, ticker, usd, hasAsset, pricesLoading, formatUsd } = params;
  const native = `${amountLabel} ${ticker}`;
  const usdReady = usd != null;
  const usdLoading = !usdReady && hasAsset && pricesLoading;
  const usdText = usdReady ? formatUsd(usd as number) : null;

  const usdSlot: SlotDisplay = usdReady
    ? { kind: 'value', text: usdText }
    : usdLoading
      ? { kind: 'loading', text: null }
      : { kind: 'status', text: 'wallet.portfolio.unavailable' };

  if (unit === 'usd') {
    // The prominent slot carries the USD conversion; when it isn't ready, fall back to the native
    // amount so the prominent slot is NEVER a broken "$—" — but a genuine "loading" still renders
    // as a skeleton (the caller checks `prominent.kind`), not the native fallback text.
    const prominent: SlotDisplay = usdSlot.kind === 'value' ? usdSlot : usdSlot.kind === 'loading' ? usdSlot : { kind: 'value', text: native };
    // The secondary line shows the native amount immediately (it never depends on price) UNLESS
    // the USD conversion is genuinely unavailable, in which case the status note takes its place.
    const secondary: SlotDisplay = usdSlot.kind === 'status' ? usdSlot : { kind: 'value', text: `≈ ${native}` };
    return { prominent, secondary };
  }

  // unit === 'xch': the prominent value never depends on price; the USD conversion is secondary.
  const secondary: SlotDisplay = usdSlot.kind === 'value' ? { kind: 'value', text: `≈ ${usdSlot.text}` } : usdSlot;
  return { prominent: { kind: 'value', text: native }, secondary };
}
