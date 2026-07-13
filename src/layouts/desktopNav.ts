import type { Tab, WalletView } from '@/app/tabs';

/**
 * One entry in the desktop (fullscreen) wallet sidebar (#85). The desktop workspace flattens the
 * wallet's segmented sub-views (Home/Activity/Trade/Collectibles/Identity) INTO the persistent left
 * nav so the whole wallet is one click away — never a single stacked, scrolling stream. Each item
 * maps to the SHARED route state (`tab` + optional `walletView`), so clicking it dispatches the same
 * `setTab`/`setWalletView` the compact popup uses — one store, no forked navigation logic.
 *
 * Labels reuse the existing message catalog (no new translations); `glyph` is a decorative emoji
 * (self-contained, no icon font) and is not user copy.
 */
export interface DesktopNavItem {
  /** Stable key for `data-testid` (`nav-<key>`) + active detection. */
  key: string;
  /** The top-level tab this item routes to. */
  tab: Tab;
  /** For `tab === 'wallet'`, the wallet sub-view this item selects. */
  walletView?: WalletView;
  /** Message-catalog id for the item's label. */
  labelId: string;
  /** Decorative leading glyph (not user copy). */
  glyph: string;
}

/**
 * The ordered desktop sidebar. Wallet-first: the wallet + its sub-views lead, then the dApp
 * launcher/store and the network surface. Order === the visual (top-to-bottom rail) order.
 */
export const DESKTOP_NAV: readonly DesktopNavItem[] = [
  { key: 'home', tab: 'home', labelId: 'tab.home', glyph: '🏠' },
  { key: 'wallet', tab: 'wallet', walletView: 'home', labelId: 'tab.wallet', glyph: '👛' },
  { key: 'activity', tab: 'wallet', walletView: 'activity', labelId: 'wallet.view.activity', glyph: '🧾' },
  { key: 'trade', tab: 'wallet', walletView: 'trade', labelId: 'wallet.view.trade', glyph: '🔁' },
  { key: 'collectibles', tab: 'wallet', walletView: 'collectibles', labelId: 'wallet.view.collectibles', glyph: '🖼️' },
  { key: 'did', tab: 'wallet', walletView: 'did', labelId: 'wallet.view.did', glyph: '🪪' },
  { key: 'apps', tab: 'apps', labelId: 'tab.apps', glyph: '🧩' },
  { key: 'network', tab: 'network', labelId: 'tab.network', glyph: '🌐' },
  // Fullscreen-only tabs (#393 Peers, #411 Advertise, #380 Tipping, #433 Security) — sidebar entries
  // with no compact bottom-nav counterpart; the desktop workspace has the room these advanced
  // surfaces need.
  { key: 'peers', tab: 'peers', labelId: 'tab.peers', glyph: '🛰️' },
  { key: 'advertise', tab: 'advertise', labelId: 'tab.advertise', glyph: '📣' },
  { key: 'tipping', tab: 'tipping', labelId: 'tab.tipping', glyph: '💸' },
  { key: 'security', tab: 'security', labelId: 'tab.security', glyph: '🔒' },
] as const;

/**
 * The {@link DESKTOP_NAV} key that is active for the current route. Wallet sub-views match on
 * `walletView`; every other tab matches on `tab`. Falls back to the tab's first item (never throws).
 * Pure (no DOM/chrome.*) so it is unit-testable.
 */
export function activeNavKey(tab: Tab, walletView: WalletView): string {
  if (tab === 'wallet') {
    const item = DESKTOP_NAV.find((i) => i.tab === 'wallet' && i.walletView === walletView);
    return item ? item.key : 'wallet';
  }
  const item = DESKTOP_NAV.find((i) => i.tab === tab);
  return item ? item.key : 'home';
}
