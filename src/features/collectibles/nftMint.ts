/**
 * Pure NFT-mint form logic (#92) — validation + the string-form → wire-params mapping the mint UI
 * (`MintNft.tsx`) uses. Kept free of chrome.* and the DOM so every branch is unit-tested. The mint is
 * built + signed in the offscreen vault (`prepareNftMint`); this module only turns the plain-language
 * form into a validated {@link WireNftMintParams} the vault understands.
 *
 * On-chain an NFT's CHIP-0007 metadata is the edition + the data/metadata/license URIs (+ optional
 * SHA-256 hashes) — the human name/description live in the OFF-CHAIN metadata JSON the metadata URI
 * points at, which the minter hosts. So the form collects URIs, not a name; the labels say so.
 */

import { isChiaAddress, toBaseUnits } from '@/lib/wallet-view';
import type { WireNftMintParams } from '@/offscreen/vault';

/** XCH has 12 decimal places (1 XCH = 10^12 mojos). */
const XCH_DECIMALS = 12;

/** The raw mint form fields (all strings, straight from the inputs). */
export interface MintForm {
  /** The media (image/audio/…) URL the NFT points at — REQUIRED. */
  mediaUri: string;
  /** Optional SHA-256 of the media content (64-hex) for integrity. */
  mediaHash: string;
  /** Optional off-chain metadata JSON URL (holds the human name/description/attributes). */
  metadataUri: string;
  metadataHash: string;
  /** Optional license document URL. */
  licenseUri: string;
  licenseHash: string;
  /** Royalty percentage as typed (e.g. "2.5"); 0–100, empty = 0. */
  royaltyPercent: string;
  /** Optional royalty payout address (bech32m `xch1…`); empty = the minting wallet. */
  royaltyAddress: string;
  /** Optional network fee in XCH. */
  fee: string;
}

/** Per-field validation errors (message ids), keyed by form field; empty when the form is valid. */
export type MintErrors = Partial<Record<keyof MintForm, string>>;

/** An all-empty starting form. */
export const EMPTY_MINT_FORM: MintForm = {
  mediaUri: '',
  mediaHash: '',
  metadataUri: '',
  metadataHash: '',
  licenseUri: '',
  licenseHash: '',
  royaltyPercent: '',
  royaltyAddress: '',
  fee: '',
};

const HEX64 = /^[0-9a-f]{64}$/i;

/** True if `s` looks like an http(s)/ipfs/ar URL (a light client-side sanity check, not a fetch). */
export function looksLikeUri(s: string): boolean {
  return /^(https?|ipfs|ar):\/\/\S+$/i.test(s.trim());
}

/** Parse a royalty percentage string (0–100) to basis points, or null if it is not a valid percent. */
export function royaltyPercentToBasisPoints(percent: string): number | null {
  const trimmed = percent.trim();
  if (trimmed === '') return 0;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return Math.round(n * 100);
}

/** Parse a fee in XCH to mojos (≥0); null if it is not a valid non-negative number. */
export function feeToMojos(fee: string): number | null {
  const trimmed = fee.trim();
  if (trimmed === '') return 0;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n === 0) return 0; // toBaseUnits rejects non-positive; a zero fee is valid here
  try {
    const mojos = toBaseUnits(trimmed, XCH_DECIMALS);
    return Number.isFinite(mojos) && mojos >= 0 ? mojos : null;
  } catch {
    return null;
  }
}

/**
 * Validate the mint form and, when valid, produce the {@link WireNftMintParams} to send to the vault.
 * The media URI is required; every supplied hash MUST be 64-hex; the royalty percent must be 0–100;
 * a supplied royalty address must be a valid bech32m Chia address; the fee must be a non-negative
 * number. Returns `{ ok:true, params }` or `{ ok:false, errors }` (never both).
 */
export function validateMintForm(form: MintForm): { ok: true; params: WireNftMintParams } | { ok: false; errors: MintErrors } {
  const errors: MintErrors = {};

  if (!form.mediaUri.trim()) errors.mediaUri = 'mint.error.mediaRequired';
  else if (!looksLikeUri(form.mediaUri)) errors.mediaUri = 'mint.error.mediaUri';

  if (form.metadataUri.trim() && !looksLikeUri(form.metadataUri)) errors.metadataUri = 'mint.error.uri';
  if (form.licenseUri.trim() && !looksLikeUri(form.licenseUri)) errors.licenseUri = 'mint.error.uri';

  const checkHash = (v: string, field: keyof MintForm): void => {
    if (v.trim() && !HEX64.test(v.trim())) errors[field] = 'mint.error.hash';
  };
  checkHash(form.mediaHash, 'mediaHash');
  checkHash(form.metadataHash, 'metadataHash');
  checkHash(form.licenseHash, 'licenseHash');

  const bps = royaltyPercentToBasisPoints(form.royaltyPercent);
  if (bps === null) errors.royaltyPercent = 'mint.error.royalty';

  if (form.royaltyAddress.trim() && !isChiaAddress(form.royaltyAddress.trim())) errors.royaltyAddress = 'mint.error.address';

  const feeMojos = feeToMojos(form.fee);
  if (feeMojos === null) errors.fee = 'mint.error.fee';

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const params: WireNftMintParams = {
    dataUris: [form.mediaUri.trim()],
    royaltyBasisPoints: bps as number,
    fee: String(feeMojos),
  };
  if (form.mediaHash.trim()) params.dataHash = form.mediaHash.trim().toLowerCase();
  if (form.metadataUri.trim()) params.metadataUris = [form.metadataUri.trim()];
  if (form.metadataHash.trim()) params.metadataHash = form.metadataHash.trim().toLowerCase();
  if (form.licenseUri.trim()) params.licenseUris = [form.licenseUri.trim()];
  if (form.licenseHash.trim()) params.licenseHash = form.licenseHash.trim().toLowerCase();
  if (form.royaltyAddress.trim()) params.royaltyAddress = form.royaltyAddress.trim();
  return { ok: true, params };
}

/** Format basis points as a percentage label (e.g. 250 → "2.5%"). */
export function basisPointsToPercentLabel(bps: number): string {
  return `${(bps / 100).toString()}%`;
}
