/**
 * dig-toolbar — MV3 content-script that injects the page toolbar (#292, restyled as native browser
 * chrome by #293).
 *
 * When the persisted toggle (`toolbar.enabled`) is ON, this injects a NATIVE-looking toolbar atop
 * EVERY ordinary web page — shadow-DOM isolated (page CSS can't touch it, its CSS can't leak), a
 * fixed top bar with the page body offset below it, colored the same neutral grey as ordinary
 * browser chrome (no DIG gradient/brand fills — it must read as browser UI, not a branded widget).
 * The bar carries:
 *   - a dedicated `chia://`/URN address bar (NOT the page's own address bar — its placeholder makes
 *     that explicit). Enter resolves the typed value against the single shared URN grammar and, when
 *     valid, hands the canonical `chia://` URL to the background `navigateToDigUrl` action — the
 *     SAME §5.3 node-or-sandbox navigation (`handleDigUrlNavigation`) the #289 nav + `dig` omnibox
 *     already use. Invalid input shows an inline error instead of navigating;
 *   - two live badges read from the node's serve headers (#289): "Verified on Chia"
 *     (`X-Dig-Verified`) and "Loaded from local" (`X-Dig-Source: local`);
 *   - ONE button that opens the fullscreen extension surface (`openExtensionPage`) — replacing the
 *     earlier per-page Wallet/DIG Shields/Control Panel icon row.
 * Toggling the setting injects or removes the bar live. The bar's light/dark paint follows its OWN
 * independent, persisted `toolbar.theme` preference (#459) — resolved + live-synced the SAME way as
 * every other pref here, and NEVER the main app theme (`uiSlice.theme` / `wallet.settings.theme`).
 *
 * This is DOM + chrome.* mounting glue; the decision logic (toggle key/default, inject-or-not,
 * URN-bar submit resolution, badge state, theme resolution, localized labels) lives in the
 * unit-tested pure core `@/lib/toolbar`. esbuild bundles it into a self-contained classic script
 * (dist/dig-toolbar.js), inlining the pure imports; the built-extension Playwright e2e
 * (e2e/sw/node-serve-omnibox-toolbar.spec.ts) validates the behaviour.
 */
import {
  TOOLBAR_ENABLED_KEY,
  TOOLBAR_ENABLED_DEFAULT,
  TOOLBAR_OPEN_PAGE,
  TOOLBAR_THEME_KEY,
  TOOLBAR_THEME_DEFAULT,
  shouldInjectToolbar,
  badgesFromHeaders,
  toolbarBadges,
  resolveUrnBarSubmit,
  toolbarLabels,
  resolveToolbarTheme,
  toolbarShortcutHint,
  isToolbarThemeMode,
  TOOLBAR_PALETTES,
  type BadgeState,
  type ToolbarLabels,
  type ToolbarThemeMode,
} from '@/lib/toolbar';
import { ACTIONS } from '@/lib/messages';

console.log('DIG Extension: page toolbar content script loaded');

const HOST_ID = 'dig-toolbar-host';
const BAR_HEIGHT = '38px';
const DARK_QUERY = '(prefers-color-scheme: dark)';
const isTop = window.top === window.self;

/** The browser's current dark-mode preference (drives the theme-matched palette, #306 item 2). */
function prefersDark(): boolean {
  try {
    return typeof window.matchMedia === 'function' && window.matchMedia(DARK_QUERY).matches;
  } catch {
    return false;
  }
}

/**
 * Best-effort: read the node's DIG Shields serve headers for a node-served page (`/s/…`). A
 * same-origin HEAD on the current URL returns the `X-Dig-*` headers the node set. Non-node pages and
 * any failure yield `null` (both badges hidden).
 */
async function readVerdict(): Promise<BadgeState | null> {
  try {
    if (!location.pathname.startsWith('/s/')) return null;
    const res = await fetch(location.href, { method: 'HEAD', cache: 'no-store' });
    return badgesFromHeaders(res.headers);
  } catch {
    return null;
  }
}

/** Remove the toolbar (if present) and undo the page body offset. */
function removeToolbar(): void {
  document.getElementById(HOST_ID)?.remove();
  try {
    document.documentElement.style.removeProperty('padding-top');
  } catch {
    /* ignore */
  }
}

/** Ask the background SW to run the §5.4 node-or-sandbox navigation for a resolved `chia://` URL
 *  (the SAME path #289's nav + the `dig` omnibox use — no second resolve/decrypt implementation). */
function navigateToDigUrl(url: string): void {
  try {
    chrome.runtime.sendMessage({ action: ACTIONS.navigateToDigUrl, url }, () => {
      void chrome.runtime.lastError;
    });
  } catch {
    /* SW gone / context invalidated */
  }
}

/** Ask the background SW to classify + resolve + navigate a raw entry input — used for the
 *  `*.on.dig.net` / `<name>.dig` shorthand, which must be resolved HEAD→URN (#308) from the
 *  extension origin (a page content script can't read the CORS-exposed `X-Dig-URN`). */
function navigateDigInput(input: string): void {
  try {
    chrome.runtime.sendMessage({ action: ACTIONS.navigateDigInput, input }, () => {
      void chrome.runtime.lastError;
    });
  } catch {
    /* SW gone / context invalidated */
  }
}

/** #366 — hide the toolbar on this page by flipping the persisted `toolbar.enabled` toggle OFF.
 *  storage.onChanged (below) then removes the bar live on THIS page and every other, and the header
 *  switch / keyboard command / re-enable affordance flip it back on. */
function hideToolbar(): void {
  try {
    void chrome.storage.local.set({ [TOOLBAR_ENABLED_KEY]: false });
  } catch {
    /* storage unavailable — best effort */
  }
}

/** #366 — ask the SW for the ACTUAL bound show/hide shortcut (a content script has no
 *  `chrome.commands` access), then paint it into the hint element. Falls back to the manifest
 *  default via `toolbarShortcutHint` on any failure/empty binding — never blank. */
function refreshShortcutHint(hintEl: HTMLElement, labels: ToolbarLabels): void {
  hintEl.textContent = toolbarShortcutHint(labels, null); // instant default; upgraded below if resolvable
  try {
    chrome.runtime.sendMessage({ action: ACTIONS.getToolbarShortcut }, (res?: { shortcut?: string }) => {
      if (chrome.runtime.lastError) return; // SW asleep / no receiver — keep the default
      hintEl.textContent = toolbarShortcutHint(labels, res && res.shortcut ? res.shortcut : null);
    });
  } catch {
    /* SW gone / context invalidated — the default hint stays */
  }
}

/** Build the shadow-DOM toolbar and mount it. Idempotent — a second call replaces the first.
 *  `themeMode` is the URN bar's OWN independent, persisted theme preference (#459) — NEVER the
 *  main app theme (this content script has no Redux store / `wallet.settings` access, and must
 *  not gain one just to paint a colour). */
function mountToolbar(badges: BadgeState | null, themeMode: ToolbarThemeMode): void {
  removeToolbar();
  const labels = toolbarLabels(navigator.languages);
  // #459 — resolve the SAME independent `toolbar.theme` preference the built-in fullscreen bar's
  // switcher writes; `system` (the default) falls back to prefers-color-scheme, reproducing the
  // pre-#459 always-follow-the-OS look. Same shared palette (#306 item 2) either way.
  const effective = resolveToolbarTheme(themeMode, prefersDark());
  const c = TOOLBAR_PALETTES[effective];

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.setAttribute('data-dig-toolbar', 'true');
  // The host itself is a fixed, full-width top strip; its Shadow DOM isolates all inner styling.
  host.style.cssText =
    'position:fixed;top:0;left:0;right:0;width:100%;height:' +
    BAR_HEIGHT +
    ';z-index:2147483647;margin:0;padding:0;border:0;';
  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  // Native browser-chrome palette (neutral grey in light, a dark toolbar surface in dark — matched
  // to the browser via prefers-color-scheme, #306 item 2) — deliberately NOT the DIG brand gradient
  // (#293 item 2): this bar must read as browser UI, not a branded widget. Colours come from the ONE
  // shared TOOLBAR_PALETTES the built-in fullscreen bar also uses, so the two mounts stay identical.
  style.textContent = `
    :host { all: initial; }
    .bar {
      box-sizing: border-box; display: flex; align-items: center; gap: 8px;
      height: ${BAR_HEIGHT}; padding: 0 8px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif;
      font-size: 13px; color: ${c.text};
      background: ${c.bar};
      border-bottom: 1px solid ${c.border};
    }
    .mark {
      flex: 0 0 auto; width: 20px; height: 20px; display: inline-flex; align-items: center;
      justify-content: center; font-size: 13px; color: ${c.mark};
    }
    .urnbar { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: 8px; }
    .urn-input {
      box-sizing: border-box; flex: 1 1 auto; min-width: 0; height: 26px; padding: 0 10px;
      font: inherit; font-size: 12.5px; color: ${c.inputText};
      background: ${c.inputBg}; border: 1px solid ${c.inputBorder}; border-radius: 13px;
      outline: none;
    }
    .urn-input::placeholder { color: ${c.placeholder}; }
    .urn-input:focus { border-color: ${c.focus}; box-shadow: 0 0 0 1px ${c.focus}; }
    .urn-input[aria-invalid="true"] { border-color: ${c.warnText}; box-shadow: 0 0 0 1px ${c.warnText}; }
    /* #366 — the muted show/hide keyboard-shortcut hint, unobtrusive beside the input. */
    .shortcut-hint {
      flex: 0 0 auto; font-size: 11px; color: ${c.placeholder}; white-space: nowrap;
      user-select: none;
    }
    .sr-only {
      position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden;
      clip: rect(0,0,0,0); white-space: nowrap; border: 0;
    }
    .badges { flex: 0 0 auto; display: flex; align-items: center; gap: 6px; }
    .badge {
      display: inline-flex; align-items: center; gap: 4px; height: 22px; padding: 0 9px;
      border-radius: 11px; font-size: 11.5px; font-weight: 500; white-space: nowrap;
      background: ${c.badgeBg}; color: ${c.badgeText};
    }
    .badge.ok { background: ${c.okBg}; color: ${c.okText}; }
    .badge.warn { background: ${c.warnBg}; color: ${c.warnText}; }
    .open-btn {
      flex: 0 0 auto; appearance: none; border: 0; cursor: pointer; background: transparent;
      color: ${c.btn}; width: 26px; height: 26px; border-radius: 6px; font-size: 15px; line-height: 1;
      display: inline-flex; align-items: center; justify-content: center;
    }
    .open-btn:hover, .open-btn:focus-visible { background: ${c.btnHover}; outline: none; }
    /* #366 — the hide (×) control, same affordance/shape as the open button. */
    .hide-btn {
      flex: 0 0 auto; appearance: none; border: 0; cursor: pointer; background: transparent;
      color: ${c.btn}; width: 26px; height: 26px; border-radius: 6px; font-size: 18px; line-height: 1;
      display: inline-flex; align-items: center; justify-content: center;
    }
    .hide-btn:hover, .hide-btn:focus-visible { background: ${c.btnHover}; outline: none; }
    /* Narrow (mobile-width) viewports: the URN bar + the essential buttons stay — collapse the
       decorative mark, the supplementary DIG-verdict badges, and the shortcut hint so the input
       keeps a usable width instead of shrinking to a sliver (§6.5 clean-spacing bar). */
    @media (max-width: 460px) {
      .mark, .badges, .shortcut-hint { display: none; }
    }
  `;
  shadow.appendChild(style);

  const bar = document.createElement('div');
  bar.className = 'bar';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', labels.toolbar);
  bar.setAttribute('data-testid', 'dig-toolbar');
  // #459 — mirrors the built-in bar's `data-theme` attribute so both mounts are provably in sync.
  bar.setAttribute('data-theme', effective);

  const mark = document.createElement('span');
  mark.className = 'mark';
  mark.setAttribute('aria-hidden', 'true');
  mark.textContent = '◈';

  const urnbar = document.createElement('div');
  urnbar.className = 'urnbar';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'urn-input';
  input.placeholder = labels.urnPlaceholder;
  input.setAttribute('aria-label', labels.urnLabel);
  input.setAttribute('data-testid', 'dig-toolbar-urn-input');
  input.autocomplete = 'off';
  input.spellcheck = false;
  const error = document.createElement('span');
  error.className = 'sr-only';
  error.setAttribute('role', 'alert');
  error.setAttribute('data-testid', 'dig-toolbar-urn-error');
  input.addEventListener('input', () => {
    input.removeAttribute('aria-invalid');
    error.textContent = '';
  });
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const result = resolveUrnBarSubmit(input.value);
    if (result.ok && result.kind === 'urn') {
      input.removeAttribute('aria-invalid');
      error.textContent = '';
      navigateToDigUrl(result.url);
    } else if (result.ok && result.kind === 'on-dig-net') {
      // <sub>.on.dig.net / <name>.dig → the SW resolves HEAD→URN (#308) from the extension origin.
      input.removeAttribute('aria-invalid');
      error.textContent = '';
      // Canonicalize the bar to `chia://<sub>.on.dig.net` (never the local node /s/ URL the tab loads).
      input.value = `chia://${result.host}`;
      navigateDigInput(result.host);
    } else if (input.value.trim()) {
      input.setAttribute('aria-invalid', 'true');
      error.textContent = labels.urnInvalid;
    }
  });
  // #366 — a muted show/hide keyboard-shortcut hint beside the input (resolved from the SW below).
  const hint = document.createElement('span');
  hint.className = 'shortcut-hint';
  hint.setAttribute('data-testid', 'dig-toolbar-shortcut-hint');
  hint.setAttribute('aria-hidden', 'true');
  refreshShortcutHint(hint, labels);
  urnbar.append(input, hint);

  const badgesEl = document.createElement('div');
  badgesEl.className = 'badges';
  const state = badges ?? toolbarBadges(null);
  if (state.verified.show) {
    const b = document.createElement('span');
    b.className = 'badge ' + (state.verified.ok ? 'ok' : 'warn');
    b.setAttribute('data-testid', 'dig-toolbar-badge-verified');
    b.setAttribute('data-ok', state.verified.ok ? 'true' : 'false');
    b.textContent = (state.verified.ok ? '✓ ' : '⚠ ') + labels.verified;
    badgesEl.appendChild(b);
  }
  if (state.local.show) {
    const b = document.createElement('span');
    b.className = 'badge';
    b.setAttribute('data-testid', 'dig-toolbar-badge-local');
    b.textContent = '⬇ ' + labels.local;
    badgesEl.appendChild(b);
  }

  // #293 item 4 — ONE button opens the fullscreen extension surface (replaces the earlier
  // per-page Wallet/DIG Shields/Control Panel icon row).
  const openBtn = document.createElement('button');
  openBtn.className = 'open-btn';
  openBtn.type = 'button';
  openBtn.textContent = '⛶';
  openBtn.title = labels.open;
  openBtn.setAttribute('aria-label', labels.open);
  openBtn.setAttribute('data-testid', 'dig-toolbar-open');
  openBtn.addEventListener('click', () => {
    try {
      chrome.runtime.sendMessage({ action: ACTIONS.openExtensionPage, page: TOOLBAR_OPEN_PAGE }, () => {
        void chrome.runtime.lastError;
      });
    } catch {
      /* SW gone / context invalidated */
    }
  });

  // #366 — the hide (×) control: flip the toggle OFF (removes the bar live everywhere). Re-enable
  // via the window-header switch, the keyboard command, or chrome://extensions/shortcuts.
  const hideBtn = document.createElement('button');
  hideBtn.className = 'hide-btn';
  hideBtn.type = 'button';
  hideBtn.textContent = '×';
  hideBtn.title = labels.hide;
  hideBtn.setAttribute('aria-label', labels.hide);
  hideBtn.setAttribute('data-testid', 'dig-toolbar-hide');
  hideBtn.addEventListener('click', hideToolbar);

  bar.append(mark, urnbar, badgesEl, openBtn, hideBtn, error);
  shadow.appendChild(bar);

  (document.documentElement || document.body).appendChild(host);
  // Offset the page so the fixed bar never covers the top of the content.
  try {
    document.documentElement.style.setProperty('padding-top', BAR_HEIGHT, 'important');
  } catch {
    /* ignore */
  }
}

/** Read the toggle + the independent theme pref (#459), then apply: inject when enabled on an
 *  ordinary top-frame web page, else remove. */
async function refresh(): Promise<void> {
  let enabled: boolean = TOOLBAR_ENABLED_DEFAULT;
  let themeMode: ToolbarThemeMode = TOOLBAR_THEME_DEFAULT;
  try {
    const got = await chrome.storage.local.get([TOOLBAR_ENABLED_KEY, TOOLBAR_THEME_KEY]);
    if (typeof got[TOOLBAR_ENABLED_KEY] === 'boolean') enabled = got[TOOLBAR_ENABLED_KEY] as boolean;
    if (isToolbarThemeMode(got[TOOLBAR_THEME_KEY])) themeMode = got[TOOLBAR_THEME_KEY];
  } catch {
    /* storage unavailable — keep the defaults (off / system) */
  }
  if (!shouldInjectToolbar(enabled, location.href, isTop)) {
    removeToolbar();
    return;
  }
  mountToolbar(await readVerdict(), themeMode);
}

// React to live toggles from the window-header switch / options page, AND to the URN-bar's OWN
// independent theme pref (#459) flipping from the built-in bar's switcher or another tab — so this
// injected mount repaints in lockstep without ever reading the app-theme store/settings blob.
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (
      area === 'local' &&
      (Object.prototype.hasOwnProperty.call(changes, TOOLBAR_ENABLED_KEY) ||
        Object.prototype.hasOwnProperty.call(changes, TOOLBAR_THEME_KEY))
    ) {
      void refresh();
    }
  });
} catch {
  /* ignore */
}

// Re-paint the bar when the browser's light/dark preference flips (#306 item 2) — re-mount so the
// theme-matched palette is recomputed for the injected bar just like the built-in one.
try {
  if (typeof window.matchMedia === 'function') {
    window.matchMedia(DARK_QUERY).addEventListener('change', () => {
      if (document.getElementById(HOST_ID)) void refresh();
    });
  }
} catch {
  /* ignore */
}

if (isTop) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => void refresh());
  } else {
    void refresh();
  }
}
