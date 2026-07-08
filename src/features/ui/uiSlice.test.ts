import { describe, it, expect } from 'vitest';
import {
  uiReducer,
  setTab,
  setWalletView,
  setNetworkView,
  setOpenApp,
  closeApp,
  setLocale,
  setAdvanced,
  setTheme,
  setChainNetwork,
  routeFromHash,
  settingsHydrated,
} from '@/features/ui/uiSlice';

const initial = () => uiReducer(undefined, { type: '@@init' });

describe('uiSlice', () => {
  it('sets tab + wallet view', () => {
    let s = uiReducer(initial(), setTab('wallet'));
    expect(s.tab).toBe('wallet');
    s = uiReducer(s, setWalletView('trade'));
    expect(s.walletView).toBe('trade');
  });

  it('sets the network sub-view', () => {
    expect(uiReducer(initial(), setNetworkView('shield')).networkView).toBe('shield');
  });

  it('opens + closes the in-window app-view', () => {
    const app = { slug: 'chia-offer', name: 'Chia-Offer', link: 'https://chia-offer.on.dig.net/' };
    let s = uiReducer(initial(), setOpenApp(app));
    expect(s.openApp).toEqual(app);
    s = uiReducer(s, closeApp());
    expect(s.openApp).toBeNull();
  });

  it('validates locale, ignoring unsupported', () => {
    let s = uiReducer(initial(), setLocale('ja'));
    expect(s.locale).toBe('ja');
    s = uiReducer(s, setLocale('xx'));
    expect(s.locale).toBe('en');
  });

  it('toggles advanced mode', () => {
    expect(uiReducer(initial(), setAdvanced(true)).advanced).toBe(true);
  });

  it('defaults theme to "system" and validates, ignoring unsupported (#111)', () => {
    expect(initial().theme).toBe('system');
    let s = uiReducer(initial(), setTheme('dark'));
    expect(s.theme).toBe('dark');
    s = uiReducer(s, setTheme('neon' as never));
    expect(s.theme).toBe('system');
  });

  it('defaults network to "mainnet" and validates, ignoring unsupported (#108)', () => {
    expect(initial().network).toBe('mainnet');
    let s = uiReducer(initial(), setChainNetwork('testnet'));
    expect(s.network).toBe('testnet');
    s = uiReducer(s, setChainNetwork('devnet' as never));
    expect(s.network).toBe('mainnet');
  });

  it('hydrates route from a hash', () => {
    const s = uiReducer(initial(), routeFromHash('#wallet/activity'));
    expect(s).toMatchObject({ tab: 'wallet', walletView: 'activity' });
  });

  it('merges persisted settings, ignoring bad/absent values', () => {
    let s = uiReducer(initial(), settingsHydrated({ locale: 'de', advanced: true }));
    expect(s).toMatchObject({ locale: 'de', advanced: true });
    s = uiReducer(s, settingsHydrated(undefined));
    expect(s).toMatchObject({ locale: 'de', advanced: true });
    s = uiReducer(s, settingsHydrated({ locale: 'zzz' }));
    expect(s.locale).toBe('de');
  });

  it('merges persisted theme + network, ignoring bad/absent values (#111, #108)', () => {
    let s = uiReducer(initial(), settingsHydrated({ theme: 'dark', network: 'testnet' }));
    expect(s).toMatchObject({ theme: 'dark', network: 'testnet' });
    s = uiReducer(s, settingsHydrated(undefined));
    expect(s).toMatchObject({ theme: 'dark', network: 'testnet' });
    s = uiReducer(s, settingsHydrated({ theme: 'neon', network: 'devnet' } as never));
    expect(s).toMatchObject({ theme: 'dark', network: 'testnet' });
  });
});
