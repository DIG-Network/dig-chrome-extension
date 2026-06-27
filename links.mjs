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

/** TibetSwap — where users buy DIG (the token spent to deploy capsules). */
export const TIBETSWAP_URL = 'https://v2.tibetswap.io/';

/** Full DIG Browser releases — the native client we soft-upsell over the extension. */
export const DIG_BROWSER_URL = 'https://github.com/DIG-Network/DIG_Browser/releases';

/**
 * Ordered list of resource links rendered in the popup's Resources/footer section.
 * `id` is used for stable hooks/tests; `external` marks links that open a new tab.
 */
export const RESOURCE_LINKS = [
  { id: 'get-dig', label: 'Get DIG', url: TIBETSWAP_URL, external: true },
  { id: 'visit-dig-network', label: 'Visit DIG Network', url: DIG_NETWORK_URL, external: true },
  { id: 'learn-the-protocol', label: 'Learn the protocol', url: DOCS_URL, external: true },
];
