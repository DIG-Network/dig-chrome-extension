/**
 * Pure option-mint form logic (#104) — validation + the string-form → wire-params mapping the mint
 * UI (`OptionsPanel.tsx`) uses. Kept free of chrome.* and the DOM so every branch is unit-tested.
 * MVP is XCH-denominated only (both the underlying and the strike), per `optionContracts.ts`'s
 * module doc — amounts are entered in XCH, expiration as a plain "days from now" (avoids a
 * timezone-sensitive date picker for the first cut).
 */

import { toBaseUnits } from '@/lib/wallet-view';
import type { WireOptionMintParams } from '@/offscreen/vault';

/** XCH has 12 decimal places (1 XCH = 10^12 mojos). */
const XCH_DECIMALS = 12;
/** Seconds in a day. */
const SECONDS_PER_DAY = 86_400;

/** The raw mint form fields (all strings, straight from the inputs). */
export interface OptionMintForm {
  /** Collateral to lock, in XCH — REQUIRED, > 0. */
  underlyingXch: string;
  /** Exercise price, in XCH — REQUIRED, > 0. */
  strikeXch: string;
  /** How many days from now the option remains exercisable — REQUIRED, > 0 (whole days). */
  expiresInDays: string;
  /** Optional network fee in XCH. */
  fee: string;
}

/** Per-field validation errors (message ids), keyed by form field; empty when the form is valid. */
export type OptionMintErrors = Partial<Record<keyof OptionMintForm, string>>;

/** An all-empty starting form. */
export const EMPTY_OPTION_MINT_FORM: OptionMintForm = { underlyingXch: '', strikeXch: '', expiresInDays: '', fee: '' };

/** Parse a positive XCH amount string to mojos; null if not a valid positive number. */
function xchToMojos(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return null;
  try {
    const mojos = toBaseUnits(trimmed, XCH_DECIMALS);
    return Number.isFinite(mojos) && mojos > 0 ? mojos : null;
  } catch {
    return null;
  }
}

/** Parse a fee in XCH to mojos (≥0); null if it is not a valid non-negative number. */
function feeToMojos(fee: string): number | null {
  const trimmed = fee.trim();
  if (trimmed === '') return 0;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n === 0) return 0;
  try {
    const mojos = toBaseUnits(trimmed, XCH_DECIMALS);
    return Number.isFinite(mojos) && mojos >= 0 ? mojos : null;
  } catch {
    return null;
  }
}

/** Parse a whole positive number of days; null if invalid. */
function daysToWhole(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) return null;
  return n;
}

/**
 * Validate the mint form and, when valid, produce the {@link WireOptionMintParams} to send to the
 * vault (`expirationSeconds` computed from `now + expiresInDays` at validation time). Returns
 * `{ ok:true, params }` or `{ ok:false, errors }` (never both).
 */
export function validateOptionMintForm(form: OptionMintForm, nowSeconds: number = Math.floor(Date.now() / 1000)): { ok: true; params: WireOptionMintParams } | { ok: false; errors: OptionMintErrors } {
  const errors: OptionMintErrors = {};

  const underlyingMojos = xchToMojos(form.underlyingXch);
  if (underlyingMojos === null) errors.underlyingXch = 'options.error.underlying';

  const strikeMojos = xchToMojos(form.strikeXch);
  if (strikeMojos === null) errors.strikeXch = 'options.error.strike';

  const days = daysToWhole(form.expiresInDays);
  if (days === null) errors.expiresInDays = 'options.error.expires';

  const feeMojos = feeToMojos(form.fee);
  if (feeMojos === null) errors.fee = 'options.error.fee';

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const expirationSeconds = nowSeconds + (days as number) * SECONDS_PER_DAY;
  return {
    ok: true,
    params: {
      underlyingAmount: String(underlyingMojos),
      strikeAmount: String(strikeMojos),
      expirationSeconds: String(expirationSeconds),
      fee: String(feeMojos),
    },
  };
}
