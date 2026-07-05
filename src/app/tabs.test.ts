import { describe, it, expect } from 'vitest';
import {
  TABS,
  DEFAULT_TAB,
  DEFAULT_WALLET_VIEW,
  DEFAULT_NETWORK_VIEW,
  isTab,
  isWalletView,
  isNetworkView,
  resolveRoute,
  routeToHash,
  tabTestId,
  tabPanelId,
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
});
