/**
 * Ambient type declarations for the SHARED plain-ES-module layer at the repo root — the pure
 * (no chrome.* / DOM) view-models the (Phase-0-preserved, still-vanilla) service worker /
 * dig-viewer / new-tab surfaces AND the React shell both import. They are the LIVE cross-surface
 * contract (not dead code): the React wallet shell consumes them via the `#shared/*` alias so a
 * single implementation drives every surface and their existing `node --test` suites remain the
 * authoritative coverage for that logic. Types are precise (no `any`).
 *
 * (The React app re-skins these models; it does NOT re-implement them. Keeping them as the shared
 * source of truth means the popup, the vanilla SW, and `node --test` never drift.)
 */

declare module '#shared/dig-urn.mjs' {
  /** A parsed Digstore URN; a null `roothash` references the store's latest capsule. */
  export interface ParsedUrn {
    chain: string;
    storeId: string;
    roothash: string | null;
    resourceKey: string;
    salt: string | null;
  }
  /** Parse a URN (with or without `chia://` / `urn:dig:` prefix). Returns null if invalid. */
  export function parseURN(urnString: string): ParsedUrn | null;
  /** Fully URL-decode a URN read from a query param (decodes percent-escapes until stable). */
  export function decodeUrnParam(raw: string | null | undefined): string;
  /** Resolve a hostname + path (dig.local / localhost / 127.0.0.1) to a URN string, or null. */
  export function resolveHostToURN(hostname: string, pathname: string): string | null;
  export function encodeStoreId(storeId: string): string;
  export function decodeStoreId(encoded: string): string;
  export function urnToContentServerUrl(urn: string, options?: { host?: string; port?: number }): string | null;
  export function hexToInt(hex: string): bigint;
  export function intToBase36(bigInt: bigint): string;
  export function base36ToInt(base36: string): bigint;
  export function intToHex(bigInt: bigint, length?: number): string;
}

