import { describe, it, expect } from 'vitest';
import {
  TABS,
  FULLSCREEN_ONLY_TABS,
  ALL_TABS,
  WALLET_VIEWS,
  DEFAULT_TAB,
  DEFAULT_WALLET_VIEW,
  DEFAULT_NETWORK_VIEW,
  isTab,
  isCompactTab,
  isWalletView,
  isNetworkView,
  resolveRoute,
  routeToHash,
  tabTestId,
  tabPanelId,
  walletViewsForSurface,
} from '@/app/tabs';

describe('tab model (mobile-OS IA)', () => {
  it('is the Home · Wallet · Apps · Network bottom nav, Home default', () => {
    expect(TABS).toEqual(['home', 'wallet', 'apps', 'network']);
    expect(DEFAULT_TAB).toBe('home');
    expect(isTab('home')).toBe(true);
    expect(isTab('network')).toBe(true);
    expect(isTab('nope')).toBe(false);
    expect(isWalletView('activity')).toBe(true);
    expect(isWalletView('nope')).toBe(false);
    expect(isNetworkView('shield')).toBe(true);
    expect(isNetworkView('nope')).toBe(false);
  });

  it('resolves routes from a hash (bare tab, tab/view, and unknowns)', () => {
    const base = { walletView: DEFAULT_WALLET_VIEW, networkView: DEFAULT_NETWORK_VIEW };
    expect(resolveRoute('#home')).toEqual({ tab: 'home', ...base });
    expect(resolveRoute('#wallet/activity')).toEqual({ tab: 'wallet', walletView: 'activity', networkView: DEFAULT_NETWORK_VIEW });
    expect(resolveRoute('#network/shield')).toEqual({ tab: 'network', walletView: DEFAULT_WALLET_VIEW, networkView: 'shield' });
    expect(resolveRoute('#apps')).toEqual({ tab: 'apps', ...base });
    expect(resolveRoute('')).toEqual({ tab: 'home', ...base });
    expect(resolveRoute('#bogus')).toEqual({ tab: 'home', ...base });
    expect(resolveRoute('#wallet/bogus')).toEqual({ tab: 'wallet', ...base });
  });

  it('adds fullscreen-only tabs (#393 Peers, #411 Advertise) — routable + deep-linkable, NOT in the compact bottom nav', () => {
    // TABS stays the clean 4-item compact bottom nav.
    expect(TABS).toEqual(['home', 'wallet', 'apps', 'network']);
    // The fullscreen-only tabs are separate, and ALL_TABS is the union.
    expect(FULLSCREEN_ONLY_TABS).toEqual(['peers', 'advertise']);
    expect(ALL_TABS).toEqual(['home', 'wallet', 'apps', 'network', 'peers', 'advertise']);
    // They are valid top-level tabs (deep-linkable), but not compact tabs (no bottom-nav entry).
    expect(isTab('peers')).toBe(true);
    expect(isTab('advertise')).toBe(true);
    expect(isCompactTab('peers')).toBe(false);
    expect(isCompactTab('advertise')).toBe(false);
    expect(isCompactTab('home')).toBe(true);
    // Deep-links resolve to the tab (no sub-views).
    expect(resolveRoute('#peers')).toEqual({ tab: 'peers', walletView: DEFAULT_WALLET_VIEW, networkView: DEFAULT_NETWORK_VIEW });
    expect(resolveRoute('#advertise')).toEqual({ tab: 'advertise', walletView: DEFAULT_WALLET_VIEW, networkView: DEFAULT_NETWORK_VIEW });
    expect(routeToHash('peers')).toBe('#peers');
    expect(routeToHash('advertise')).toBe('#advertise');
  });

  it('maps legacy bare network deep-links to the Network screen sub-view (back-compat)', () => {
    expect(resolveRoute('#resolver')).toEqual({ tab: 'network', walletView: DEFAULT_WALLET_VIEW, networkView: 'resolver' });
    expect(resolveRoute('#shield')).toEqual({ tab: 'network', walletView: DEFAULT_WALLET_VIEW, networkView: 'shield' });
    expect(resolveRoute('#control')).toEqual({ tab: 'network', walletView: DEFAULT_WALLET_VIEW, networkView: 'control' });
  });

  it('serializes routes back to a hash (wallet + network keep their sub-view)', () => {
    expect(routeToHash('home')).toBe('#home');
    expect(routeToHash('wallet', 'home')).toBe('#wallet');
    expect(routeToHash('wallet', 'trade')).toBe('#wallet/trade');
    expect(routeToHash('apps')).toBe('#apps');
    expect(routeToHash('network')).toBe('#network');
    expect(routeToHash('network', 'home', 'shield')).toBe('#network/shield');
  });

  it('derives stable testids/panel ids', () => {
    expect(tabTestId('wallet')).toBe('tab-wallet');
    expect(tabPanelId('network')).toBe('network-panel');
  });

  // #163 — Identity (DID management) is ADVANCED functionality → the compact popup hides the
  // top-level "Identity" segmented-tab entry entirely; the fullscreen (ExpandedLayout) surface
  // shows every wallet view, Identity included. The DID list itself may still be reached
  // view-only via a deep link on the compact surface (DidPanel handles that) — this only governs
  // which segments render as TABS.
  it('hides the "did" (Identity) wallet-view tab on the compact surface, shows it on fullscreen', () => {
    expect(walletViewsForSurface(false)).toEqual(['home', 'activity', 'trade', 'collectibles']);
    expect(walletViewsForSurface(false)).not.toContain('did');
    expect(walletViewsForSurface(true)).toEqual(WALLET_VIEWS);
    expect(walletViewsForSurface(true)).toContain('did');
  });
});
