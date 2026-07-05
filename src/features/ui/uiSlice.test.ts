import { describe, it, expect } from 'vitest';
import {
  uiReducer,
  setTab,
  setWalletView,
  setLocale,
  setAdvanced,
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

  it('validates locale, ignoring unsupported', () => {
    let s = uiReducer(initial(), setLocale('ja'));
    expect(s.locale).toBe('ja');
    s = uiReducer(s, setLocale('xx'));
    expect(s.locale).toBe('en');
  });

  it('toggles advanced mode', () => {
    expect(uiReducer(initial(), setAdvanced(true)).advanced).toBe(true);
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
});
