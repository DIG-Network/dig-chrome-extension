/**
 * dig-toolbar — MV3 content-script that injects the #292 page toolbar.
 *
 * When the persisted toggle (`toolbar.enabled`) is ON, this injects a native-looking, chia://-aware
 * toolbar atop EVERY ordinary web page — shadow-DOM isolated (page CSS can't touch it, its CSS can't
 * leak), a fixed top bar with the page body offset below it. The bar carries per-page icons that
 * open the full-page extension surfaces (#140/#141: Wallet / DIG Shields / Control Panel) plus two
 * live badges read from the node's serve headers (#289): "Verified on Chia" (`X-Dig-Verified`) and
 * "Loaded from local" (`X-Dig-Source: local`). Toggling the setting injects or removes the bar live.
 *
 * This is DOM + chrome.* mounting glue; the decision logic (toggle key/default, icon→page map,
 * inject-or-not, badge state, localized labels) lives in the unit-tested pure core `@/lib/toolbar`.
 * esbuild bundles it into a self-contained classic script (dist/dig-toolbar.js), inlining the pure
 * imports; the built-extension Playwright e2e (e2e/sw/page-toolbar.spec.ts) validates the behaviour.
 */
import {
  TOOLBAR_ENABLED_KEY,
  TOOLBAR_ENABLED_DEFAULT,
  TOOLBAR_ITEMS,
  shouldInjectToolbar,
  badgesFromHeaders,
  toolbarBadges,
  toolbarLabels,
  type BadgeState,
} from '@/lib/toolbar';
import { ACTIONS } from '@/lib/messages';

console.log('DIG Extension: page toolbar content script loaded');

const HOST_ID = 'dig-toolbar-host';
const BAR_HEIGHT = '40px';
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
  style.textContent = `
    :host { all: initial; }
    .bar {
      box-sizing: border-box; display: flex; align-items: center; gap: 12px;
      height: ${BAR_HEIGHT}; padding: 0 14px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 13px; color: #fff;
      background: linear-gradient(135deg, #5800D6 0%, #FF00DE 100%);
      box-shadow: 0 1px 6px rgba(20,18,43,0.25);
    }
    .brand { display: flex; align-items: center; gap: 7px; font-weight: 700; letter-spacing: .2px; }
    .brand .mark {
      width: 20px; height: 20px; border-radius: 5px; display: inline-flex; align-items: center;
      justify-content: center; background: rgba(255,255,255,0.18); font-size: 11px; font-weight: 800;
    }
    .spacer { flex: 1 1 auto; }
    .badges { display: flex; align-items: center; gap: 8px; }
    .badge {
      display: inline-flex; align-items: center; gap: 5px; height: 24px; padding: 0 10px;
      border-radius: 12px; font-size: 12px; font-weight: 600; white-space: nowrap;
      background: rgba(255,255,255,0.16);
    }
    .badge.ok { background: rgba(20,160,90,0.95); }
    .badge.warn { background: rgba(200,60,60,0.95); }
    .icons { display: flex; align-items: center; gap: 4px; }
    .icon {
      appearance: none; border: 0; cursor: pointer; background: transparent; color: #fff;
      width: 28px; height: 28px; border-radius: 7px; font-size: 15px; line-height: 1;
      display: inline-flex; align-items: center; justify-content: center;
    }
    .icon:hover, .icon:focus-visible { background: rgba(255,255,255,0.2); outline: none; }
  `;
  shadow.appendChild(style);

  const bar = document.createElement('div');
  bar.className = 'bar';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', labels.toolbar);
  bar.setAttribute('data-testid', 'dig-toolbar');

  const brand = document.createElement('div');
  brand.className = 'brand';
  const mark = document.createElement('span');
  mark.className = 'mark';
  mark.textContent = 'D';
  mark.setAttribute('aria-hidden', 'true');
  const wordmark = document.createElement('span');
  wordmark.textContent = 'DIG';
  brand.append(mark, wordmark);

  const spacer = document.createElement('div');
  spacer.className = 'spacer';

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

  const iconsEl = document.createElement('div');
  iconsEl.className = 'icons';
  const iconLabel: Record<(typeof TOOLBAR_ITEMS)[number]['id'], string> = {
    wallet: labels.wallet,
    shields: labels.shields,
    control: labels.control,
  };
  for (const item of TOOLBAR_ITEMS) {
    const btn = document.createElement('button');
    btn.className = 'icon';
    btn.type = 'button';
    btn.textContent = item.glyph;
    btn.title = iconLabel[item.id];
    btn.setAttribute('aria-label', iconLabel[item.id]);
    btn.setAttribute('data-testid', `dig-toolbar-icon-${item.id}`);
    btn.addEventListener('click', () => {
      try {
        chrome.runtime.sendMessage({ action: ACTIONS.openExtensionPage, page: item.page }, () => {
          void chrome.runtime.lastError;
        });
      } catch {
        /* SW gone / context invalidated */
      }
    });
    iconsEl.appendChild(btn);
  }

  bar.append(brand, spacer, badgesEl, iconsEl);
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

// React to live toggles from the options page / popup.
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
