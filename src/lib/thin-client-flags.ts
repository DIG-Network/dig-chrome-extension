/**
 * Thin-client cutover feature flag (#374/#375) — the SINGLE master switch that flips the extension
 * from LOCAL self-custody (the offscreen DIGWX1 vault + coinset fallback) to NODE custody (the
 * dig-node is the only custodian + signer + wallet-data source, epic #365). It is a PURE reader over
 * a persisted `chrome.storage.local` boolean, chrome.*-free so the decision is fully unit-tested and
 * inlinable into the service worker.
 *
 * # Why a flag (HARD safety rule, task #374 rule 2)
 * The cutover DELETES key material. To keep the wallet usable at EVERY commit, the destructive purge
 * + the coinset removal (#375) are gated behind this flag, which flips ON only once the node path is
 * PROVEN working (the one-time seed migration succeeded AND the node is proven to sign on this
 * caller's behalf — see {@link ../lib/node-migration}). Flag OFF (the default) = today's local-custody
 * behavior, byte-unchanged. Flag ON = the node is the only wallet path; local key logic is bypassed
 * then purged. Nothing routes to the node-only path — and nothing is purged — while the flag is OFF.
 */

/** `chrome.storage.local` key holding the thin-client cutover flag (a boolean). SW-owned. */
export const THIN_CLIENT_FLAG_KEY = 'feature.thinClientCutover';

/**
 * The default cutover state: OFF. A wallet that predates the cutover (no flag persisted) keeps the
 * local self-custody + coinset behavior until migration proves the node path and the flag is set.
 */
export const DEFAULT_THIN_CLIENT_CUTOVER = false;

/** A loose view of the persisted `chrome.storage.local` blob (only the key this module reads). */
export interface ThinClientFlagBlob {
  [THIN_CLIENT_FLAG_KEY]?: unknown;
  [k: string]: unknown;
}

/**
 * Read the thin-client cutover flag from a persisted storage blob. Strictly boolean-true enables the
 * cutover; anything else (unset, `false`, a non-boolean) is OFF — so a corrupt/partial value can
 * never silently purge a user's keys or strand their wallet on a node-only path.
 */
export function isThinClientCutoverEnabled(blob?: ThinClientFlagBlob | null): boolean {
  return blob?.[THIN_CLIENT_FLAG_KEY] === true;
}
