import { describe, it, expect } from 'vitest';
import {
  TOOLBAR_ENABLED_KEY,
  TOOLBAR_ENABLED_DEFAULT,
  TOOLBAR_OPEN_PAGE,
  shouldInjectToolbar,
  toolbarBadges,
  badgesFromHeaders,
  resolveUrnBarSubmit,
  toolbarLabels,
} from '@/lib/toolbar';

const STORE_ID = 'a'.repeat(64);

describe('toolbar toggle contract', () => {
  it('persists under a stable key and defaults OFF (opt-in — it injects into every page)', () => {
    expect(TOOLBAR_ENABLED_KEY).toBe('toolbar.enabled');
    expect(TOOLBAR_ENABLED_DEFAULT).toBe(false);
  });
});

describe('TOOLBAR_OPEN_PAGE (#293 single button)', () => {
  it('opens the fullscreen extension surface with no sub-view deep-link', () => {
    expect(TOOLBAR_OPEN_PAGE).toBe('app.html');
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

describe('resolveUrnBarSubmit (#293 URN address bar)', () => {
  it('resolves a chia:// URL to the canonical content-view URL', () => {
    const r = resolveUrnBarSubmit(`chia://${STORE_ID}/index.html`);
    expect(r.ok).toBe(true);
    expect(r.url).toBe(`chia://chia:${STORE_ID}/index.html`);
  });

  it('resolves a bare 64-hex store id (no scheme) the same way', () => {
    const r = resolveUrnBarSubmit(STORE_ID);
    expect(r.ok).toBe(true);
    expect(r.url).toContain(STORE_ID);
  });

  it('resolves a urn:dig: URN', () => {
    const r = resolveUrnBarSubmit(`urn:dig:chia:${STORE_ID}`);
    expect(r.ok).toBe(true);
    expect(r.url).toContain(STORE_ID);
  });

  it('rejects garbage / unparseable input without a url', () => {
    expect(resolveUrnBarSubmit('not a urn')).toEqual({ ok: false, url: null });
    expect(resolveUrnBarSubmit('https://example.com')).toEqual({ ok: false, url: null });
  });

  it('rejects empty / whitespace-only input', () => {
    expect(resolveUrnBarSubmit('')).toEqual({ ok: false, url: null });
    expect(resolveUrnBarSubmit('   ')).toEqual({ ok: false, url: null });
  });
});

describe('toolbarLabels', () => {
  it('returns English labels by default, "Verified on Chia" preserved verbatim (brand)', () => {
    const l = toolbarLabels(['en']);
    expect(l.verified).toBe('Verified on Chia');
    expect(l.local).toBeTruthy();
    expect(l.open).toBeTruthy();
    expect(l.urnPlaceholder).toBeTruthy();
    expect(l.urnLabel).toBeTruthy();
    expect(l.urnInvalid).toBeTruthy();
  });

  it('localizes for a supported locale, keeping the brand phrase verbatim', () => {
    const de = toolbarLabels(['de-DE', 'en']);
    expect(de.verified).toBe('Verified on Chia'); // brand literal, never translated
    expect(de.open).toBeTruthy();
    expect(de.urnPlaceholder).toBeTruthy();
  });

  it('falls back to English for an unsupported locale', () => {
    expect(toolbarLabels(['xx']).open).toBe('Open DIG extension');
    expect(toolbarLabels(undefined).open).toBe('Open DIG extension');
  });
});
