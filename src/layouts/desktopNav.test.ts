import { describe, it, expect } from 'vitest';
import { DESKTOP_NAV, activeNavKey } from '@/layouts/desktopNav';
import { ALL_TABS, WALLET_VIEWS } from '@/app/tabs';

describe('desktopNav model (#85)', () => {
  it('exposes a flat, wallet-centric sidebar model that flattens the wallet sub-views', () => {
    const keys = DESKTOP_NAV.map((i) => i.key);
    // Every wallet sub-view is a first-class sidebar entry (the flat IA the desktop workspace wants).
    for (const view of WALLET_VIEWS) {
      const item = DESKTOP_NAV.find((i) => i.tab === 'wallet' && i.walletView === view);
      expect(item, `missing wallet/${view}`).toBeTruthy();
    }
    // Plus the non-wallet top-level tabs (home / apps / network) — no duplicate keys.
    expect(keys).toContain('home');
    expect(keys).toContain('apps');
    expect(keys).toContain('network');
    // Fullscreen-only tabs (#393 Peers, #411 Advertise, #380 Tipping, #433 Security, #516 Updates)
    // are first-class sidebar entries.
    expect(keys).toContain('peers');
    expect(keys).toContain('advertise');
    expect(keys).toContain('tipping');
    expect(keys).toContain('security');
    expect(keys).toContain('updates');
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('carries a stable label id + glyph for every item (labels reuse the existing catalog)', () => {
    for (const item of DESKTOP_NAV) {
      expect(item.labelId).toMatch(/\./); // namespaced id
      expect(item.glyph.length).toBeGreaterThan(0);
      expect((ALL_TABS as readonly string[]).includes(item.tab)).toBe(true);
    }
  });

  it('resolves the fullscreen-only tabs as their own active nav key', () => {
    expect(activeNavKey('peers', 'home')).toBe('peers');
    expect(activeNavKey('advertise', 'home')).toBe('advertise');
    expect(activeNavKey('tipping', 'home')).toBe('tipping');
    expect(activeNavKey('security', 'home')).toBe('security');
    expect(activeNavKey('updates', 'home')).toBe('updates');
  });

  it('resolves the active item from the route: wallet sub-views match walletView, other tabs match tab', () => {
    expect(activeNavKey('wallet', 'home')).toBe('wallet');
    expect(activeNavKey('wallet', 'activity')).toBe('activity');
    expect(activeNavKey('wallet', 'trade')).toBe('trade');
    expect(activeNavKey('wallet', 'collectibles')).toBe('collectibles');
    expect(activeNavKey('wallet', 'did')).toBe('did');
    expect(activeNavKey('home', 'home')).toBe('home');
    expect(activeNavKey('apps', 'home')).toBe('apps');
    expect(activeNavKey('network', 'home')).toBe('network');
  });
});
