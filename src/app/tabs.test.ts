import { describe, it, expect } from 'vitest';
import {
  TABS,
  DEFAULT_TAB,
  DEFAULT_WALLET_VIEW,
  isTab,
  isWalletView,
  resolveRoute,
  routeToHash,
  tabTestId,
  tabPanelId,
} from '@/app/tabs';

describe('tab model', () => {
  it('has the five tabs incl. the new apps tab, wallet-first + wallet default', () => {
    expect(TABS).toEqual(['wallet', 'apps', 'resolver', 'shield', 'control']);
    expect(DEFAULT_TAB).toBe('wallet');
    expect(isTab('apps')).toBe(true);
    expect(isTab('nope')).toBe(false);
    expect(isWalletView('activity')).toBe(true);
    expect(isWalletView('nope')).toBe(false);
  });

  it('resolves routes from a hash (bare tab, tab/view, and unknowns)', () => {
    expect(resolveRoute('#wallet')).toEqual({ tab: 'wallet', walletView: DEFAULT_WALLET_VIEW });
    expect(resolveRoute('#wallet/activity')).toEqual({ tab: 'wallet', walletView: 'activity' });
    expect(resolveRoute('#apps')).toEqual({ tab: 'apps', walletView: 'home' });
    expect(resolveRoute('')).toEqual({ tab: 'wallet', walletView: 'home' });
    expect(resolveRoute('#bogus')).toEqual({ tab: 'wallet', walletView: 'home' });
    expect(resolveRoute('#wallet/bogus')).toEqual({ tab: 'wallet', walletView: 'home' });
  });

  it('serializes routes back to a hash', () => {
    expect(routeToHash('resolver')).toBe('#resolver');
    expect(routeToHash('wallet', 'home')).toBe('#wallet');
    expect(routeToHash('wallet', 'trade')).toBe('#wallet/trade');
    expect(routeToHash('apps')).toBe('#apps');
  });

  it('derives stable testids/panel ids', () => {
    expect(tabTestId('wallet')).toBe('tab-wallet');
    expect(tabPanelId('shield')).toBe('shield-panel');
  });
});
