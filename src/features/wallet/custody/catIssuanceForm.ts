/**
 * Pure CAT-issuance form logic (#97) — validation + the string-form → wire-params mapping the
 * issuance UI (`CatIssuancePanel.tsx`) uses. Kept free of chrome.* and the DOM so every branch is
 * unit-tested. The issuance is built + signed in the offscreen vault (`prepareCatIssuance`); this
 * module only turns the plain-language form into a validated {@link WireCatIssuanceParams}.
 *
 * The supply is entered in WHOLE TOKENS at the ecosystem's standard CAT convention of 3 decimals
 * (`CAT_DECIMALS`, `catMetadata.ts` — denom 1000, the same default every unknown/new CAT in this
 * wallet already renders at) — so "1,000,000" in the form mints 1,000,000,000 base units on chain.
 */

import { toBaseUnits } from '@/lib/wallet-view';
import { CAT_DECIMALS } from '@/features/wallet/catMetadata';
import type { WireCatIssuanceParams } from '@/offscreen/vault';
import type { CatIssuanceMode } from '@/offscreen/catIssuance';

/** The raw issuance form fields (all strings, straight from the inputs). */
export interface CatIssuanceForm {
  /** Total supply to mint, in whole tokens (3-decimal convention) — REQUIRED, > 0. */
  supply: string;
  mode: CatIssuanceMode;
  /** Optional network fee in XCH. */
  fee: string;
}

/** Per-field validation errors (message ids), keyed by form field; empty when the form is valid. */
export type CatIssuanceErrors = Partial<Record<keyof CatIssuanceForm, string>>;

/** An all-empty starting form (single-issuance default — the common "create a fixed-supply token" case). */
export const EMPTY_CAT_ISSUANCE_FORM: CatIssuanceForm = { supply: '', mode: 'single', fee: '' };

/** Parse a fee in XCH to mojos (≥0); null if it is not a valid non-negative number. */
function feeToMojos(fee: string): number | null {
  const trimmed = fee.trim();
  if (trimmed === '') return 0;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n === 0) return 0; // toBaseUnits rejects non-positive; a zero fee is valid here
  const XCH_DECIMALS = 12;
  try {
    const mojos = toBaseUnits(trimmed, XCH_DECIMALS);
    return Number.isFinite(mojos) && mojos >= 0 ? mojos : null;
  } catch {
    return null;
  }
}

/** Parse a whole-token supply string to base units (3-decimal convention); null if invalid/non-positive. */
export function supplyToBaseUnits(supply: string): number | null {
  const trimmed = supply.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return null;
  try {
    const base = toBaseUnits(trimmed, CAT_DECIMALS);
    return Number.isFinite(base) && base > 0 ? base : null;
  } catch {
    return null;
  }
}

/**
 * Validate the issuance form and, when valid, produce the {@link WireCatIssuanceParams} to send to
 * the vault. The supply must be a positive number; the fee (if given) must be a non-negative number.
 * Returns `{ ok:true, params }` or `{ ok:false, errors }` (never both).
 */
export function validateCatIssuanceForm(form: CatIssuanceForm): { ok: true; params: WireCatIssuanceParams } | { ok: false; errors: CatIssuanceErrors } {
  const errors: CatIssuanceErrors = {};

  const supplyBase = supplyToBaseUnits(form.supply);
  if (supplyBase === null) errors.supply = 'issue.error.supply';

  const feeMojos = feeToMojos(form.fee);
  if (feeMojos === null) errors.fee = 'issue.error.fee';

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  return {
    ok: true,
    params: { amount: String(supplyBase), mode: form.mode, fee: String(feeMojos) },
  };
}
