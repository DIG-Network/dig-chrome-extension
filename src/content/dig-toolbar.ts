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
 * Toggling the setting injects or removes the bar live.
 *
 * This is DOM + chrome.* mounting glue; the decision logic (toggle key/default, inject-or-not,
 * URN-bar submit resolution, badge state, localized labels) lives in the unit-tested pure core
 * `@/lib/toolbar`. esbuild bundles it into a self-contained classic script (dist/dig-toolbar.js),
 * inlining the pure imports; the built-extension Playwright e2e
 * (e2e/sw/node-serve-omnibox-toolbar.spec.ts) validates the behaviour.
 */
import {
  TOOLBAR_ENABLED_KEY,
  TOOLBAR_ENABLED_DEFAULT,
  TOOLBAR_OPEN_PAGE,
  shouldInjectToolbar,
  badgesFromHeaders,
  toolbarBadges,
  resolveUrnBarSubmit,
  toolbarLabels,
  type BadgeState,
} from '@/lib/toolbar';
import { ACTIONS } from '@/lib/messages';

console.log('DIG Extension: page toolbar content script loaded');

const HOST_ID = 'dig-toolbar-host';
const BAR_HEIGHT = '38px';
const isTop = window.top === window.self;

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

/** Ask the background SW to run the §5.3 node-or-sandbox navigation for a resolved `chia://` URL
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

/** Build the shadow-DOM toolbar and mount it. Idempotent — a second call replaces the first. */
function mountToolbar(badges: BadgeState | null): void {
  removeToolbar();
  const labels = toolbarLabels(navigator.languages);

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
  // Native browser-chrome palette (neutral grey, matches an ordinary Chrome toolbar) — deliberately
  // NOT the DIG brand gradient (#293 item 2): this bar must read as browser UI, not a branded widget.
  style.textContent = `
    :host { all: initial; }
    .bar {
      box-sizing: border-box; display: flex; align-items: center; gap: 8px;
      height: ${BAR_HEIGHT}; padding: 0 8px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif;
      font-size: 13px; color: #3c4043;
      background: #f1f3f4;
      border-bottom: 1px solid #dadce0;
    }
    .mark {
      flex: 0 0 auto; width: 20px; height: 20px; display: inline-flex; align-items: center;
      justify-content: center; font-size: 13px; color: #5f6368;
    }
    .urnbar { flex: 1 1 auto; min-width: 0; }
    .urn-input {
      box-sizing: border-box; width: 100%; height: 26px; padding: 0 10px;
      font: inherit; font-size: 12.5px; color: #202124;
      background: #ffffff; border: 1px solid #dadce0; border-radius: 13px;
      outline: none;
    }
    .urn-input::placeholder { color: #80868b; }
    .urn-input:focus { border-color: #1a73e8; box-shadow: 0 0 0 1px #1a73e8; }
    .urn-input[aria-invalid="true"] { border-color: #c5221f; box-shadow: 0 0 0 1px #c5221f; }
    .sr-only {
      position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden;
      clip: rect(0,0,0,0); white-space: nowrap; border: 0;
    }
    .badges { flex: 0 0 auto; display: flex; align-items: center; gap: 6px; }
    .badge {
      display: inline-flex; align-items: center; gap: 4px; height: 22px; padding: 0 9px;
      border-radius: 11px; font-size: 11.5px; font-weight: 500; white-space: nowrap;
      background: #e8eaed; color: #3c4043;
    }
    .badge.ok { background: #e6f4ea; color: #137333; }
    .badge.warn { background: #fce8e6; color: #c5221f; }
    .open-btn {
      flex: 0 0 auto; appearance: none; border: 0; cursor: pointer; background: transparent;
      color: #5f6368; width: 26px; height: 26px; border-radius: 6px; font-size: 15px; line-height: 1;
      display: inline-flex; align-items: center; justify-content: center;
    }
    .open-btn:hover, .open-btn:focus-visible { background: rgba(0,0,0,0.06); outline: none; }
    /* Narrow (mobile-width) viewports: the URN bar + the single open button are the two essential
       elements — collapse the decorative mark + the supplementary DIG-verdict badges so the input
       keeps a usable width instead of shrinking to a sliver (§6.5 clean-spacing bar). */
    @media (max-width: 460px) {
      .mark, .badges { display: none; }
    }
  `;
  shadow.appendChild(style);

  const bar = document.createElement('div');
  bar.className = 'bar';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', labels.toolbar);
  bar.setAttribute('data-testid', 'dig-toolbar');

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
    if (result.ok && result.url) {
      input.removeAttribute('aria-invalid');
      error.textContent = '';
      navigateToDigUrl(result.url);
    } else if (input.value.trim()) {
      input.setAttribute('aria-invalid', 'true');
      error.textContent = labels.urnInvalid;
    }
  });
  urnbar.append(input);

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

  bar.append(mark, urnbar, badgesEl, openBtn, error);
  shadow.appendChild(bar);

  (document.documentElement || document.body).appendChild(host);
  // Offset the page so the fixed bar never covers the top of the content.
  try {
    document.documentElement.style.setProperty('padding-top', BAR_HEIGHT, 'important');
  } catch {
    /* ignore */
  }
}

/** Read the toggle + apply: inject when enabled on an ordinary top-frame web page, else remove. */
async function refresh(): Promise<void> {
  let enabled: boolean = TOOLBAR_ENABLED_DEFAULT;
  try {
    const got = await chrome.storage.local.get(TOOLBAR_ENABLED_KEY);
    if (typeof got[TOOLBAR_ENABLED_KEY] === 'boolean') enabled = got[TOOLBAR_ENABLED_KEY] as boolean;
  } catch {
    /* storage unavailable — keep the default (off) */
  }
  if (!shouldInjectToolbar(enabled, location.href, isTop)) {
    removeToolbar();
    return;
  }
  mountToolbar(await readVerdict());
}

// React to live toggles from the Home tab / options page.
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && Object.prototype.hasOwnProperty.call(changes, TOOLBAR_ENABLED_KEY)) {
      void refresh();
    }
  });
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
