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

declare module '#shared/links.mjs' {
  export const HUB_URL: string;
  export const DIG_NETWORK_URL: string;
  export const DOCS_URL: string;
  export const EXPLORE_URL: string;
  export const BUGREPORT_URL: string;
  export const DIG_ASSET_ID: string;
  export const TIBETSWAP_URL: string;
  export const DEXIE_DIG_URL: string;
  export const NINEMM_DIG_URL: string;
  export const GET_DIG_SOURCES: Array<{ name: string; url: string; hint: string }>;
  export const DISCORD_URL: string;
  export const DIG_BROWSER_URL: string;
  export const SPACESCAN_URL: string;
  export function spaceScanCoinUrl(id: string | null): string | null;
  export function spaceScanAddressUrl(address: string | null): string | null;
  export const RESOURCE_LINKS: Array<{ id: string; label: string; url: string; external: boolean }>;
}

declare module '#shared/wallet-view.mjs' {
  export const XCH_MOJOS_PER_UNIT: number;
  export const DIG_BASE_UNITS_PER_UNIT: number;
  export function pickBalance(resp: unknown): number | null;
  export function formatBaseUnits(value: number | string | null, decimalsOrAsset: number | string): string;
  export function formatXch(mojos: number | string | null): string;
  export function formatDig(baseUnits: number | string | null): string;
  export function formatAssetBalance(resp: unknown, decimalsOrAsset: number | string): string;
  export function toBaseUnits(amountStr: string, decimalsOrAsset: number | string): number;
  export function shortenAddress(addr: string | null, head?: number, tail?: number): string;
  export function validateSendForm(form: {
    address?: string;
    amount?: string;
    asset?: string;
    fee?: string;
  }): { ok: boolean; errors: { address?: string; amount?: string; fee?: string } };
  export interface ActivityItem {
    id: string;
    rawId: string | null;
    direction: 'in' | 'out';
    asset: string;
    amountLabel: string;
    timeLabel: string;
    timestamp: number;
    memo: string;
    feeLabel: string;
    statusLabel: string;
    confirmed: boolean;
    spaceScanUrl: string | null;
  }
  export function activityViewModel(
    raw: unknown,
    opts?: { digAssetId?: string; max?: number },
  ): ActivityItem[];
}

declare module '#shared/wallet-assets.mjs' {
  export const XCH_META: { key: string; ticker: string; name: string; decimals: number; assetId: null };
  export const DIG_META: { key: string; ticker: string; name: string; decimals: number; assetId: string };
  export const CAT_DECIMALS: number;
  export interface AssetDescriptor {
    key: 'xch' | 'dig' | 'cat';
    ticker: string;
    name: string;
    decimals: number;
    assetId: string | null;
    type: 'cat' | null;
  }
  export function normalizeCatId(raw: unknown): string | null;
  export function parseWatchedCats(stored: unknown): Array<{ assetId: string; name: string }>;
  export function addWatchedCat(
    list: unknown,
    rawId: string,
    name?: string,
  ): { ok: boolean; list: Array<{ assetId: string; name: string }>; error: string | null };
  export function removeWatchedCat(list: unknown, rawId: string): Array<{ assetId: string; name: string }>;
  export function assetDescriptors(watchedCats: unknown): AssetDescriptor[];
  export function sendAssetOptions(watchedCats: unknown): Array<{ value: string; label: string }>;
  export function resolveSendAsset(
    value: string,
    watchedCats: unknown,
  ): { type: 'cat' | null; assetId: string | null; decimals: number; ticker: string } | null;
}

declare module '#shared/wallet-offers.mjs' {
  export function validateOfferString(str: string): { ok: boolean; error: string | null };
  export function buildOfferParams(form: {
    giveValue?: string;
    giveAmount?: string;
    getValue?: string;
    getAmount?: string;
    watchedCats?: unknown;
    fee?: string;
  }): {
    ok: boolean;
    params: { offerAssets: Array<{ assetId: string; amount: number }>; requestAssets: Array<{ assetId: string; amount: number }>; fee: number } | null;
    error: string | null;
  };
  export interface OfferLeg {
    ticker: string;
    assetId: string | null;
    amountLabel: string;
  }
  export function offerSummaryViewModel(
    raw: unknown,
    opts?: { watchedCats?: unknown },
  ): { offered: OfferLeg[]; requested: OfferLeg[]; fee: number; feeLabel: string };
}

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

declare module '#shared/store-refs.mjs' {
  /** A resolved store reference: a capsule (`storeId`[:`root`]) + a resource key (+ optional salt). */
  export interface StoreRef {
    storeId: string;
    root?: string | null;
    resourceKey?: string;
    salt?: string | null;
  }
  /** A parsed absolute DIG reference (`chia://` / `urn:dig:chia:`). */
  export interface ParsedDigRef {
    storeId: string;
    root: string | null;
    resourceKey: string;
    salt: string | null;
  }
  /** Context for {@link classifyReference}: the current capsule + the current document's key. */
  export interface ClassifyContext {
    cfg?: { storeId?: string; root?: string | null; salt?: string | null } | null;
    baseKey?: string;
    pageOrigin?: string | null;
  }
  /** How the interceptor must treat a single reference. */
  export type ClassifiedRef =
    | { kind: 'urn'; ref: StoreRef & { storeId: string; resourceKey: string } }
    | { kind: 'relative'; ref: StoreRef & { storeId: string; resourceKey: string } }
    | { kind: 'external' };
  export function stripQueryHash(p: unknown): string;
  export function normalizePath(path: unknown): string;
  export function resolveRelativeResourceKey(baseKey: string, ref: string): string;
  export function parseDigRef(raw: unknown): ParsedDigRef | null;
  export function classifyReference(rawRef: unknown, ctx?: ClassifyContext): ClassifiedRef;
  /** Build the `chia://` URL the background `proxyRequest` reads, from a resolved ref. */
  export function buildDigUrl(ref: StoreRef): string;
  /** Infer a MIME type from a resource key's extension (mirror of the on.dig.net contentType map). */
  export function contentType(resourceKey: string): string;
}
