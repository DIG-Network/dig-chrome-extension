import { describe, it, expect } from 'vitest';
import {
  TOOLBAR_ENABLED_KEY,
  TOOLBAR_ENABLED_DEFAULT,
  TOOLBAR_ITEMS,
  shouldInjectToolbar,
  toolbarBadges,
  badgesFromHeaders,
  toolbarLabels,
} from '@/lib/toolbar';

describe('toolbar toggle contract', () => {
  it('persists under a stable key and defaults OFF (opt-in — it injects into every page)', () => {
    expect(TOOLBAR_ENABLED_KEY).toBe('toolbar.enabled');
    expect(TOOLBAR_ENABLED_DEFAULT).toBe(false);
  });
});

describe('TOOLBAR_ITEMS', () => {
  it('opens the three full-page surfaces (#140/#141): Wallet, DIG Shields, Control Panel', () => {
    expect(TOOLBAR_ITEMS.map((i) => i.id)).toEqual(['wallet', 'shields', 'control']);
    const byId = Object.fromEntries(TOOLBAR_ITEMS.map((i) => [i.id, i.page]));
    expect(byId.wallet).toBe('app.html#wallet');
    expect(byId.shields).toBe('app.html#network/shield');
    expect(byId.control).toBe('app.html#network/control');
  });

  it('every item has a glyph', () => {
    for (const i of TOOLBAR_ITEMS) expect(i.glyph.length).toBeGreaterThan(0);
  });
});

describe('shouldInjectToolbar', () => {
  it('injects on ordinary web pages only when enabled', () => {
    expect(shouldInjectToolbar(true, 'https://example.com')).toBe(true);
    expect(shouldInjectToolbar(true, 'http://dig.local/s/abc/')).toBe(true);
    expect(shouldInjectToolbar(false, 'https://example.com')).toBe(false);
  });

  it('never injects on extension/chrome/about pages or in sub-frames', () => {
    expect(shouldInjectToolbar(true, 'chrome-extension://x/app.html')).toBe(false);
    expect(shouldInjectToolbar(true, 'chrome://settings')).toBe(false);
    expect(shouldInjectToolbar(true, 'about:blank')).toBe(false);
    expect(shouldInjectToolbar(true, 'https://example.com', false)).toBe(false);
  });
});

describe('toolbarBadges', () => {
  it('shows the Verified badge (ok) when the node reports verified true', () => {
    expect(toolbarBadges({ verified: true, root: null, source: 'local' })).toEqual({
      verified: { show: true, ok: true },
      local: { show: true },
    });
  });

  it('shows the Verified badge in a failed state when the node reports verified false', () => {
    expect(toolbarBadges({ verified: false, root: null, source: 'peer' })).toEqual({
      verified: { show: true, ok: false },
      local: { show: false },
    });
  });

  it('hides both badges on a non-node-served page (no headers)', () => {
    expect(toolbarBadges(null)).toEqual({ verified: { show: false, ok: false }, local: { show: false } });
    expect(toolbarBadges({ verified: null, root: null, source: null })).toEqual({
      verified: { show: false, ok: false },
      local: { show: false },
    });
  });

  it('badgesFromHeaders parses headers then derives badge state', () => {
    expect(badgesFromHeaders({ 'X-Dig-Verified': 'true', 'X-Dig-Source': 'local' })).toEqual({
      verified: { show: true, ok: true },
      local: { show: true },
    });
  });
});

describe('toolbarLabels', () => {
  it('returns English labels by default, "Verified on Chia" preserved verbatim (brand)', () => {
    const l = toolbarLabels(['en']);
    expect(l.verified).toBe('Verified on Chia');
    expect(l.wallet).toBe('Wallet');
    expect(l.local).toBeTruthy();
  });

  it('localizes for a supported locale, keeping the brand phrase verbatim', () => {
    const de = toolbarLabels(['de-DE', 'en']);
    expect(de.verified).toBe('Verified on Chia'); // brand literal, never translated
    expect(de.wallet).toBeTruthy();
  });

  it('falls back to English for an unsupported locale', () => {
    expect(toolbarLabels(['xx']).wallet).toBe('Wallet');
    expect(toolbarLabels(undefined).wallet).toBe('Wallet');
  });
});
