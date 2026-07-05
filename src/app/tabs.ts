/**
 * The React shell's tab model — the single source of truth for the 5-tab popup surface and the
 * wallet's Home/Activity/Trade sub-routes.
 *
 * This EXTENDS the legacy 4-tab set (`#shared/tabs.mjs`, still driving the vanilla surfaces + its
 * own `node --test` suite) with the new **Apps** tab (#59, an in-window embed of explore.dig.net).
 * It is TypeScript-first because the shell is TypeScript-first; the shared `.mjs` model is left
 * untouched so the legacy contract can't regress. Pure (no DOM / chrome.*) so it is unit-testable
 * and the router stays thin glue over it.
 */

/**
 * The ordered top-shell tab set. Order === the visual (bottom-bar / sidebar) order.
 *
 * WALLET-FIRST per the ladder-of-needs IA (the wallet is the many-times-a-day surface; Apps is the
 * "what now?" surface; resolver/shield/control are ambient/pull-on-failure). The fuller
 * Wallet · Apps · Network grouping (a single Network tab hosting Resolver | Shield | Node) is a
 * planned fast-follow; Phase 0 ships the wallet-first order + the wallet default.
 */
export const TABS = ['wallet', 'apps', 'resolver', 'shield', 'control'] as const;
export type Tab = (typeof TABS)[number];

/** The tab shown when the popup opens with no deep-link — the wallet (the glance-many×/day surface). */
export const DEFAULT_TAB: Tab = 'wallet';

/** The wallet tab's segmented sub-views (the Balances & Intents home + ledger + offers). */
export const WALLET_VIEWS = ['home', 'activity', 'trade'] as const;
export type WalletView = (typeof WALLET_VIEWS)[number];

/** The default wallet sub-view. */
export const DEFAULT_WALLET_VIEW: WalletView = 'home';

/** True if `name` is one of the known tabs. */
export function isTab(name: string): name is Tab {
  return (TABS as readonly string[]).includes(name);
}

/** True if `name` is one of the known wallet sub-views. */
export function isWalletView(name: string): name is WalletView {
  return (WALLET_VIEWS as readonly string[]).includes(name);
}

/**
 * Resolve `{ tab, walletView }` from a `location.hash`. Accepts a bare tab (`#wallet`), a
 * tab/subview pair (`#wallet/activity`), or an empty/unknown hash (→ defaults). Never throws.
 */
export function resolveRoute(hash: string | null | undefined): { tab: Tab; walletView: WalletView } {
  const raw = String(hash || '').replace(/^#/, '');
  const [tabPart = '', viewPart = ''] = raw.split('/');
  const tab = isTab(tabPart) ? tabPart : DEFAULT_TAB;
  const walletView = isWalletView(viewPart) ? viewPart : DEFAULT_WALLET_VIEW;
  return { tab, walletView };
}

/** Serialize a route back to a `#tab` or `#tab/view` hash (wallet keeps its sub-view). */
export function routeToHash(tab: Tab, walletView: WalletView = DEFAULT_WALLET_VIEW): string {
  if (tab === 'wallet' && walletView !== DEFAULT_WALLET_VIEW) return `#wallet/${walletView}`;
  return `#${tab}`;
}

/** The stable, agent-driveable `data-testid` of the tab button for `tab`. */
export function tabTestId(tab: Tab): string {
  return `tab-${tab}`;
}

/** The DOM id / testid of the tabpanel element for `tab`. */
export function tabPanelId(tab: Tab): string {
  return `${tab}-panel`;
}
