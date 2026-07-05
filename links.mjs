/**
 * Ecosystem funnel links — the single source of truth for every outbound link the
 * extension surfaces (popup "Browse DIGHUb" button, popup Resources/footer, and the
 * first-run welcome page).
 *
 * Why a shared module: the popup (popup.html via popup.js) and the welcome page
 * (welcome.html, which is also driven from background.js's onInstalled) must point at
 * exactly the same destinations. Keeping the URLs in one place means a funnel target
 * can never drift between surfaces. This file is an ES module so it can be imported by
 * the module service worker (background.js) and unit-tested under `node --test`; the
 * popup loads the same constants via popup.js.
 */

/** hub.dig.net — the publishing/control-plane surface the extension funnels into. */
export const HUB_URL = 'https://hub.dig.net';

/** dig.net — the DIG Network marketing/landing surface. */
export const DIG_NETWORK_URL = 'https://dig.net';

/** docs.dig.net — protocol + integration documentation. */
export const DOCS_URL = 'https://docs.dig.net';

/** explore.dig.net — the curated DIG Network dApp store (the "Explore DIG Network" action). */
export const EXPLORE_URL = 'https://explore.dig.net';

/** bugreport.dig.net — the ecosystem bug-report funnel (§6.7); repo-scoped via a query param. */
export const BUGREPORT_URL = 'https://bugreport.dig.net';

/**
 * The DIG CAT asset id (tail hash, plain hex). Pinned; never user-supplied. Mirrors hub
 * `apps/web/lib/links.js` `DIG_ASSET_ID` so the dexie/9mm venue URLs are byte-identical
 * to the hub's canonical Get-$DIG sources.
 */
export const DIG_ASSET_ID =
  'a406d3a9de984d03c9591c10d917593b434d5263cabe2b42f6b367df16832f81';

/** 1. TibetSwap — the XCH↔$DIG AMM. The original (and still primary) acquisition path. */
export const TIBETSWAP_URL = 'https://v2.tibetswap.io/';

/** 2. dexie.space — the $DIG/XCH market on the dexie DEX (per-CAT swap route by tail hash). */
export const DEXIE_DIG_URL = `https://dexie.space/offers/${DIG_ASSET_ID}/XCH`;

/** 3. xch.9mm.pro — the 9mm.pro token page for the DIG CAT. */
export const NINEMM_DIG_URL = `https://xch.9mm.pro/token/${DIG_ASSET_ID}`;

/**
 * The canonical ordered list of ways to get $DIG — TibetSwap, then dexie, then 9mm.pro.
 * Mirrors hub `apps/web/lib/links.js` `GET_DIG_SOURCES` so every surface that funnels a user
 * to acquire $DIG offers the SAME three venues in the SAME order. `name` is the short venue
 * label; `hint` is a one-line description for menus.
 */
export const GET_DIG_SOURCES = [
  { name: 'TibetSwap', url: TIBETSWAP_URL, hint: 'XCH ↔ DIG AMM' },
  { name: 'dexie', url: DEXIE_DIG_URL, hint: 'DIG / XCH on the dexie DEX' },
  { name: '9mm.pro', url: NINEMM_DIG_URL, hint: 'DIG token on 9mm.pro' },
];

/** The DIG Network community Discord — the canonical org invite (matches dig.net + docs + hub). */
export const DISCORD_URL = 'https://discord.gg/dignetwork';

/** Full DIG Browser releases — the native client we soft-upsell over the extension. */
export const DIG_BROWSER_URL = 'https://github.com/DIG-Network/DIG_Browser/releases';

/** SpaceScan — the Chia mainnet block explorer the wallet Activity view links each tx to. */
export const SPACESCAN_URL = 'https://www.spacescan.io';

/**
 * SpaceScan coin page for a coin/transaction id. Chia has no Ethereum-style tx hashes; the
 * durable on-chain handle is the coin id, which SpaceScan indexes at `/coin/0x…`. Normalises a
 * bare 64-hex id to the `0x` form SpaceScan expects; passes an already-`0x` id through. Returns
 * `null` for an empty/absent id so the renderer can omit the link honestly.
 * @param {string} id a coin/transaction id (with or without `0x`)
 * @returns {string|null}
 */
export function spaceScanCoinUrl(id) {
  const s = String(id == null ? '' : id).trim();
  if (!s) return null;
  const withPrefix = /^0x/i.test(s) ? s : `0x${s}`;
  return `${SPACESCAN_URL}/coin/${withPrefix}`;
}

/** SpaceScan address page for a bech32 `xch1…` address; `null` for an empty address. */
export function spaceScanAddressUrl(address) {
  const s = String(address == null ? '' : address).trim();
  if (!s) return null;
  return `${SPACESCAN_URL}/address/${s}`;
}

/**
 * Ordered list of resource links rendered in the popup's Resources/footer section.
 * `id` is used for stable hooks/tests; `external` marks links that open a new tab.
 * "Get $DIG" leads to TibetSwap (the primary venue); the popup wallet panel also surfaces
 * all three {@link GET_DIG_SOURCES}.
 */
export const RESOURCE_LINKS = [
  { id: 'get-dig', label: 'Get $DIG', url: TIBETSWAP_URL, external: true },
  { id: 'visit-dig-network', label: 'Visit DIG Network', url: DIG_NETWORK_URL, external: true },
  { id: 'learn-the-protocol', label: 'Learn the protocol', url: DOCS_URL, external: true },
];
