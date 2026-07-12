/**
 * The React shell's tab model — the single source of truth for the mobile-OS surface (#65): a
 * phone-style bottom nav of four screens (Home · Wallet · Apps · Network) plus the wallet's
 * Home/Activity/Trade sub-routes and the Network screen's Resolver/Shield/Control sub-routes.
 *
 * The IA follows the Fable Wallet · Apps · Network grouping: HOME is the launcher (widgets + app
 * icons), and the three ambient/pull-on-failure surfaces (resolver, shield, control) live together
 * under NETWORK — so every surface stays reachable from a clean 4-item nav. Legacy deep-links
 * (`#resolver`/`#shield`/`#control`) still resolve (→ the Network screen on that sub-view) for
 * back-compat with the pop-out + external links. Pure (no DOM/chrome.*) so it is unit-testable.
 */

/** The ordered bottom-nav screens. Order === the visual (bottom-bar / rail) order. HOME first. */
export const TABS = ['home', 'wallet', 'apps', 'network'] as const;

/**
 * Fullscreen-only top-level tabs (#393 Peers, #411 Advertise, #380 Tipping, #433 Security). They are
 * reachable from the desktop (fullscreen) sidebar {@link DESKTOP_NAV} and via deep-links (`#peers`/
 * `#advertise`/`#tipping`/`#security`), but are NOT rendered in the compact phone bottom nav — which
 * stays a clean 4-item bar.
 * This mirrors the advanced-surface tiering the wallet views use (§145): advanced surfaces live
 * fullscreen-only.
 */
export const FULLSCREEN_ONLY_TABS = ['peers', 'advertise', 'tipping', 'security'] as const;

/** Every routable top-level tab: the compact bottom-nav set plus the fullscreen-only tabs. */
export const ALL_TABS = [...TABS, ...FULLSCREEN_ONLY_TABS] as const;

/** A routable top-level tab. */
export type Tab = (typeof ALL_TABS)[number];
/** A tab that renders in the compact phone bottom nav (the {@link TABS} subset). */
export type CompactTab = (typeof TABS)[number];

/** The screen shown when the surface opens with no deep-link — the mobile-OS Home launcher. */
export const DEFAULT_TAB: Tab = 'home';

/** The wallet screen's segmented sub-views (Balances & Intents home + ledger + offers + collectibles + identity). */
export const WALLET_VIEWS = ['home', 'activity', 'trade', 'collectibles', 'did'] as const;
export type WalletView = (typeof WALLET_VIEWS)[number];
/** The default wallet sub-view. */
export const DEFAULT_WALLET_VIEW: WalletView = 'home';

/**
 * Wallet views that are ADVANCED functionality (§145 surface tiering) and therefore never render
 * as a top-level segmented TAB on the compact (popup) surface — fullscreen only. Identity (DID
 * management) is advanced (#163): creating/transferring a DID was already fullscreen-only (#93),
 * but the "Identity" tab ENTRY itself still leaked into the compact segmented control. The DID
 * list remains reachable view-only on the compact surface via a direct deep link (`DidPanel`
 * handles that independently) — this constant only governs which segments render as tabs.
 */
const COMPACT_ADVANCED_WALLET_VIEWS: readonly WalletView[] = ['did'];

/**
 * The wallet-view segments to render as tabs for a given surface. Fullscreen (`isFull: true`)
 * shows every {@link WALLET_VIEWS} entry; the compact popup drops {@link COMPACT_ADVANCED_WALLET_VIEWS}
 * (#163). Pure (no DOM/chrome.*) so it is unit-testable.
 */
export function walletViewsForSurface(isFull: boolean): readonly WalletView[] {
  return isFull ? WALLET_VIEWS : WALLET_VIEWS.filter((v) => !COMPACT_ADVANCED_WALLET_VIEWS.includes(v));
}

/** The Network screen's segmented sub-views (the resolver, the proof shield, the node control panel). */
export const NETWORK_VIEWS = ['resolver', 'shield', 'control'] as const;
export type NetworkView = (typeof NETWORK_VIEWS)[number];
/** The default Network sub-view. */
export const DEFAULT_NETWORK_VIEW: NetworkView = 'resolver';

/** True if `name` is one of the known top-level tabs (compact bottom-nav OR fullscreen-only). */
export function isTab(name: string): name is Tab {
  return (ALL_TABS as readonly string[]).includes(name);
}

/** True if `tab` renders in the compact phone bottom nav (excludes the fullscreen-only tabs). */
export function isCompactTab(tab: Tab): tab is CompactTab {
  return (TABS as readonly string[]).includes(tab);
}

/** True if `name` is one of the known wallet sub-views. */
export function isWalletView(name: string): name is WalletView {
  return (WALLET_VIEWS as readonly string[]).includes(name);
}

/** True if `name` is one of the known Network sub-views. */
export function isNetworkView(name: string): name is NetworkView {
  return (NETWORK_VIEWS as readonly string[]).includes(name);
}

/** A fully-resolved route: the active tab + both segmented sub-views. */
export interface Route {
  tab: Tab;
  walletView: WalletView;
  networkView: NetworkView;
}

/**
 * Resolve a {@link Route} from a `location.hash`. Accepts a bare tab (`#home`), a tab/subview pair
 * (`#wallet/activity`, `#network/shield`), a LEGACY bare network surface (`#resolver`/`#shield`/
 * `#control` → the Network screen on that sub-view, for back-compat), or empty/unknown (→ defaults).
 * Never throws.
 */
export function resolveRoute(hash: string | null | undefined): Route {
  const raw = String(hash || '').replace(/^#/, '');
  const [head = '', sub = ''] = raw.split('/');
  const base: Route = { tab: DEFAULT_TAB, walletView: DEFAULT_WALLET_VIEW, networkView: DEFAULT_NETWORK_VIEW };

  // Legacy bare network surface (`#resolver`, `#shield`, `#control`) → Network screen on that view.
  if (isNetworkView(head)) return { ...base, tab: 'network', networkView: head };

  const tab = isTab(head) ? head : DEFAULT_TAB;
  const walletView = tab === 'wallet' && isWalletView(sub) ? sub : DEFAULT_WALLET_VIEW;
  const networkView = tab === 'network' && isNetworkView(sub) ? sub : DEFAULT_NETWORK_VIEW;
  return { tab, walletView, networkView };
}

/** Serialize a route back to a `#tab` / `#tab/view` hash (wallet + network keep their sub-view). */
export function routeToHash(
  tab: Tab,
  walletView: WalletView = DEFAULT_WALLET_VIEW,
  networkView: NetworkView = DEFAULT_NETWORK_VIEW,
): string {
  if (tab === 'wallet' && walletView !== DEFAULT_WALLET_VIEW) return `#wallet/${walletView}`;
  if (tab === 'network' && networkView !== DEFAULT_NETWORK_VIEW) return `#network/${networkView}`;
  return `#${tab}`;
}

/** The stable, agent-driveable `data-testid` of the bottom-nav button for `tab`. */
export function tabTestId(tab: Tab): string {
  return `tab-${tab}`;
}

/** The DOM id / testid of the screen panel element for `tab`. */
export function tabPanelId(tab: Tab): string {
  return `${tab}-panel`;
}
