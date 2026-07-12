import { describe, it, expect } from 'vitest';
import {
  TOOLBAR_ENABLED_KEY,
  TOOLBAR_ENABLED_DEFAULT,
  TOOLBAR_OPEN_PAGE,
  TOOLBAR_TOGGLE_COMMAND,
  TOOLBAR_TOGGLE_SHORTCUT_DEFAULT,
  shouldInjectToolbar,
  toolbarBadges,
  badgesFromHeaders,
  resolveUrnBarSubmit,
  toolbarLabels,
  toolbarTheme,
  toolbarShortcutHint,
  TOOLBAR_PALETTES,
  TOOLBAR_THEME_KEY,
  TOOLBAR_THEME_DEFAULT,
  TOOLBAR_THEME_MODES,
  isToolbarThemeMode,
  resolveToolbarTheme,
  nextToolbarTheme,
} from '@/lib/toolbar';
import { LOCALES } from '@/i18n/locales';

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

  // #421 rule 2 — the injected content-script toolbar must NEVER render on chrome-extension://
  // origins (every extension surface gets the BUILT-IN bar instead), so there is never a double
  // toolbar. Locked for every extension page, not just app.html.
  it('never injects on extension/chrome/about pages or in sub-frames (#421 — no double toolbar)', () => {
    expect(shouldInjectToolbar(true, 'chrome-extension://x/app.html')).toBe(false);
    expect(shouldInjectToolbar(true, 'chrome-extension://x/newtab.html')).toBe(false);
    expect(shouldInjectToolbar(true, 'chrome-extension://x/dig-viewer.html')).toBe(false);
    expect(shouldInjectToolbar(true, 'chrome-extension://x/options.html')).toBe(false);
    expect(shouldInjectToolbar(true, 'moz-extension://x/app.html')).toBe(false);
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

describe('resolveUrnBarSubmit (#293/#306/#310/#362 URN address bar — all entry forms)', () => {
  it('resolves a chia:// URL to a urn submit with the canonical content-view URL', () => {
    const r = resolveUrnBarSubmit(`chia://${STORE_ID}/index.html`);
    expect(r).toEqual({ ok: true, kind: 'urn', url: `chia://chia:${STORE_ID}/index.html` });
  });

  it('resolves a bare 64-hex store id (no scheme) as a urn submit', () => {
    const r = resolveUrnBarSubmit(STORE_ID);
    expect(r.ok).toBe(true);
    if (r.ok && r.kind === 'urn') expect(r.url).toContain(STORE_ID);
  });

  it('resolves the bare urn:dig:chia: scheme form as a urn submit (#310)', () => {
    const r = resolveUrnBarSubmit(`urn:dig:chia:${STORE_ID}`);
    expect(r.ok).toBe(true);
    if (r.ok && r.kind === 'urn') expect(r.url).toContain(STORE_ID);
  });

  it('resolves an *.on.dig.net / <name>.dig shorthand as an on-dig-net submit (#308)', () => {
    expect(resolveUrnBarSubmit('shop.on.dig.net')).toEqual({ ok: true, kind: 'on-dig-net', host: 'shop.on.dig.net' });
    expect(resolveUrnBarSubmit('alice.dig')).toEqual({ ok: true, kind: 'on-dig-net', host: 'alice.on.dig.net' });
  });

  it('rejects a plain web URL / free text (the URN bar accepts DIG addresses only)', () => {
    expect(resolveUrnBarSubmit('https://example.com')).toEqual({ ok: false });
    expect(resolveUrnBarSubmit('not a urn')).toEqual({ ok: false });
  });

  it('rejects empty / whitespace-only input', () => {
    expect(resolveUrnBarSubmit('')).toEqual({ ok: false });
    expect(resolveUrnBarSubmit('   ')).toEqual({ ok: false });
  });
});

describe('toolbar theme (#306 — prefers-color-scheme match, both mounts share one palette)', () => {
  it('selects dark under prefers-color-scheme: dark, else light', () => {
    expect(toolbarTheme(true)).toBe('dark');
    expect(toolbarTheme(false)).toBe('light');
  });

  it('light is neutral Chrome grey; dark is a dark toolbar surface (NOT the DIG brand gradient)', () => {
    expect(TOOLBAR_PALETTES.light.bar).toBe('#f1f3f4');
    expect(TOOLBAR_PALETTES.dark.bar).toBe('#292a2d');
    // Distinct text colours prove the two themes actually differ.
    expect(TOOLBAR_PALETTES.light.text).not.toBe(TOOLBAR_PALETTES.dark.text);
    for (const t of ['light', 'dark'] as const) {
      const p = TOOLBAR_PALETTES[t];
      expect(p.bar).toMatch(/^#/);
      expect(p.okText).toMatch(/^#/);
      expect(p.warnText).toMatch(/^#/);
    }
  });
});

describe('URN-bar independent theme state (#459 — decoupled from the main app theme)', () => {
  it('persists under its OWN flat storage key, distinct from the app theme (wallet.settings.theme)', () => {
    expect(TOOLBAR_THEME_KEY).toBe('toolbar.theme');
    expect(TOOLBAR_THEME_KEY).not.toBe('wallet.settings.theme');
    expect(TOOLBAR_THEME_KEY).not.toBe('theme');
  });

  it('defaults to system — reproduces the toolbar\'s pre-#459 always-follow-the-OS behavior', () => {
    expect(TOOLBAR_THEME_DEFAULT).toBe('system');
    expect(TOOLBAR_THEME_MODES).toContain('system');
    expect(TOOLBAR_THEME_MODES).toEqual(['light', 'dark', 'system']);
  });

  it('isToolbarThemeMode accepts light/dark/system and rejects anything else', () => {
    expect(isToolbarThemeMode('light')).toBe(true);
    expect(isToolbarThemeMode('dark')).toBe(true);
    expect(isToolbarThemeMode('system')).toBe(true);
    expect(isToolbarThemeMode('sepia')).toBe(false);
    expect(isToolbarThemeMode('')).toBe(false);
    expect(isToolbarThemeMode(undefined)).toBe(false);
    expect(isToolbarThemeMode(null)).toBe(false);
    expect(isToolbarThemeMode(1)).toBe(false);
  });

  it('resolveToolbarTheme: system follows the OS signal; light/dark pass through as explicit locks', () => {
    expect(resolveToolbarTheme('system', true)).toBe('dark');
    expect(resolveToolbarTheme('system', false)).toBe('light');
    expect(resolveToolbarTheme('light', true)).toBe('light');
    expect(resolveToolbarTheme('dark', false)).toBe('dark');
  });

  it('nextToolbarTheme always resolves to an explicit opposite, never back to system', () => {
    expect(nextToolbarTheme('light')).toBe('dark');
    expect(nextToolbarTheme('dark')).toBe('light');
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

  it('every locale carries a non-empty hide label + shortcut-hint template (#366)', () => {
    for (const { code } of LOCALES) {
      const l = toolbarLabels([code]);
      expect(l.hide, `hide (${code})`).toBeTruthy();
      expect(l.shortcutHint, `shortcutHint (${code})`).toBeTruthy();
      // The template MUST carry the {key} placeholder toolbarShortcutHint substitutes.
      expect(l.shortcutHint, `shortcutHint placeholder (${code})`).toContain('{key}');
    }
  });
});

describe('toolbar show/hide keyboard command (#366)', () => {
  it('names a stable chrome.commands id matching manifest.json', () => {
    expect(TOOLBAR_TOGGLE_COMMAND).toBe('toggle-dig-toolbar');
  });

  it('has a sensible cross-platform default shown before the real binding resolves', () => {
    expect(TOOLBAR_TOGGLE_SHORTCUT_DEFAULT).toBe('Alt+Shift+D');
  });
});

describe('toolbarShortcutHint (#366 item 4 — the muted hint shown in the URN bar)', () => {
  it('uses the resolved shortcut when one is given', () => {
    const labels = toolbarLabels(['en']);
    expect(toolbarShortcutHint(labels, 'Alt+Shift+K')).toBe(labels.shortcutHint.replace('{key}', 'Alt+Shift+K'));
    expect(toolbarShortcutHint(labels, 'Alt+Shift+K')).toContain('Alt+Shift+K');
  });

  it('falls back to the default when the shortcut is unresolved (null/empty)', () => {
    const labels = toolbarLabels(['en']);
    expect(toolbarShortcutHint(labels, null)).toContain(TOOLBAR_TOGGLE_SHORTCUT_DEFAULT);
    expect(toolbarShortcutHint(labels, undefined)).toContain(TOOLBAR_TOGGLE_SHORTCUT_DEFAULT);
    expect(toolbarShortcutHint(labels, '')).toContain(TOOLBAR_TOGGLE_SHORTCUT_DEFAULT);
    expect(toolbarShortcutHint(labels, '   ')).toContain(TOOLBAR_TOGGLE_SHORTCUT_DEFAULT);
  });
});
