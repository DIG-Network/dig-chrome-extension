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

declare module '#shared/messages.mjs' {
  export const MESSAGE_PROTOCOL_VERSION: number;
  export const ACTIONS: Readonly<Record<string, string>>;
  export const BRIDGE: Readonly<Record<string, string>>;
  /** Discriminator on SW→offscreen-vault messages (#56). */
  export const OFFSCREEN_TARGET: string;
  export function isKnownAction(action: string): boolean;
  export function buildCapabilities(extensionVersion?: string): {
    version: string;
    messageProtocol: number;
    actions: string[];
    walletMethods: string[];
    stateChangingMethods: string[];
    errorCodes: string[];
    bridge: Record<string, string>;
  };
}

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

declare module '#shared/wallet-methods.mjs' {
  export const WALLET_METHODS: readonly string[];
  export const STATE_CHANGING_METHODS: readonly string[];
  export function normalizeMethod(method: string): string;
  export function isSupportedMethod(method: string): boolean;
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

declare module '#shared/resolve-status.mjs' {
  export const HOSTED_GATEWAY: string;
  export const RESOLVE_TIERS: readonly string[];
  export function isCustomHost(customHost: string): boolean;
  export function resolveViaStatus(
    status?: { reachable?: boolean; base?: string | null },
    opts?: { customHost?: string },
  ): { tier: 'custom' | 'dig.local' | 'localhost' | 'rpc.dig.net'; label: string; endpoint: string };
}

declare module '#shared/dig-control.mjs' {
  export const HOSTED_RPC_FALLBACK: string;
  export const CONTROL_METHODS: readonly string[];
  export function controlPanelViewModel(view: unknown): {
    mode: 'manage' | 'install';
    nodeOnline: boolean;
    base: string | null;
    authRequired: boolean;
    hasStats: boolean;
    stats: {
      hostedStores: number | string;
      cachedCapsules: number | string;
      cacheUsedBytes: number | null;
      syncOn: boolean;
    } | null;
    upstream: string;
    deepLinkBrowser: boolean;
    note: string;
    install: { title: string; body: string; installLabel: string; installUrl: string };
    readFallbackLine: string;
  };
  export function controlInstallPrompt(): { title: string; body: string; installLabel: string; installUrl: string };
}

declare module '#shared/dig-ledger.mjs' {
  export interface LedgerEntry {
    resourcePath: string;
    storeId: string;
    rootHash: string;
    inclusionProofPassed: boolean;
    errorCode: string;
    executionProofStatus: string;
  }
  export function capsuleKey(storeId: string, rootHash: string): string;
  export function groupLedger(entries: LedgerEntry[]): {
    passed: LedgerEntry[];
    failed: LedgerEntry[];
    passedCount: number;
    failedCount: number;
    total: number;
    allPassed: boolean;
    empty: boolean;
  };
  export function inclusionProofDisplay(e: LedgerEntry): {
    verified: boolean;
    proofRoot: string;
    hasRoot: boolean;
    storeId: string;
    errorCode: string;
    label: string;
  };
  export function executionProofDisplay(e: LedgerEntry): {
    verified: boolean;
    state: 'verified' | 'mock' | 'pending' | 'absent' | 'unknown';
    status: string;
    label: string;
  };
}

declare module '#shared/qr.mjs' {
  export function qrSvg(text: string, size?: number): string;
}
