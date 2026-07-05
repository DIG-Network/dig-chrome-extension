// Type declarations for dig-urn.mjs — the single shared URN parser + base36 store-id helpers.

/**
 * A parsed Digstore URN. With a `roothash` it identifies a specific *capsule* (the immutable
 * generation `storeId:roothash`); a null `roothash` references the store's latest capsule.
 * `salt` is the optional private-store hex salt (null for a public store).
 */
export interface ParsedUrn {
  chain: string;
  storeId: string;
  roothash: string | null;
  resourceKey: string;
  salt: string | null;
}

/** Parse a URN (with or without `chia://` / `urn:dig:` prefix). Returns null if invalid. */
export function parseURN(urnString: string): ParsedUrn | null;

/**
 * Fully URL-decode a URN read from a query param, decoding percent-escapes until stable (a valid
 * URN has no literal `%`). Recovers a URN that was encoded more than once by a navigation path.
 */
export function decodeUrnParam(raw: string | null | undefined): string;

/** Resolve a hostname + path (dig.local / localhost / 127.0.0.1) to a URN string, or null. */
export function resolveHostToURN(hostname: string, pathname: string): string | null;

/** Encode a 64-hex store id to base36 (subdomain-safe). */
export function encodeStoreId(storeId: string): string;
/** Decode a base36 store id back to 64-hex. */
export function decodeStoreId(encoded: string): string;

/** Convert a URN to a content-server URL (subdomain format). Returns null if invalid. */
export function urnToContentServerUrl(urn: string, options?: { host?: string; port?: number }): string | null;

export function hexToInt(hex: string): bigint;
export function intToBase36(bigInt: bigint): string;
export function base36ToInt(base36: string): bigint;
export function intToHex(bigInt: bigint, length?: number): string;
