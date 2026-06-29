// Type declarations for error-codes.mjs — the catalogued chia:// loader error codes.
// The four canonical codes mirror docs.dig.net static/error-codes.json `dig-loader` surface.

export type DigErrorCode =
  | 'DIG_ERR_PROOF_MISMATCH'
  | 'DIG_ERR_DECRYPT_TAG'
  | 'DIG_ERR_NOT_FOUND'
  | 'DIG_ERR_NETWORK'
  | 'DIG_ERR_INVALID_URN'
  | 'DIG_ERR_DIGNODE_REQUIRED';

export const DIG_ERR: Readonly<Record<DigErrorCode, DigErrorCode>>;

/** The canonical cross-surface `dig-loader` subset (exactly the four shared codes). */
export const DIG_LOADER_CODES: readonly DigErrorCode[];

export interface ErrorCatalogueEntry {
  code: DigErrorCode;
  message: string;
  /** true when the code is part of the shared cross-surface dig-loader subset. */
  canonical: boolean;
}
export const ERROR_CATALOGUE: readonly ErrorCatalogueEntry[];

/** Classify a raw failure (string or Error) into a stable DigErrorCode. */
export function classifyError(input: string | Error | null | undefined): DigErrorCode;

/** The coded loader-failure envelope: stable machine code + the original human message. */
export interface CodedError {
  success: false;
  code: DigErrorCode;
  message: string;
}

/** Build a `{ success:false, code, message }` envelope, classifying unless `codeOverride` is given. */
export function makeError(input: string | Error | null | undefined, codeOverride?: DigErrorCode): CodedError;
