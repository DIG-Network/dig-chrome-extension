import { test, expect, type Page } from '@playwright/test';

/**
 * Screenshot + render checks for #311 (the instant DIG loader page) and #366 (the built-in toolbar's
 * show/hide shortcut hint), driven against the REAL built bundles (`dist-web`) over the static server.
 *
 * The loader page (`dig-loader.html`) is a standalone extension page (no `chrome.*` — it just parses
 * `?input=` and paints the branded shell), so it renders directly over http. The built-in toolbar
 * lives in `app.html`; a canned `chrome.*` stub with `toolbar.enabled: true` mounts it so the muted
 * shortcut hint is captured. (The INJECTED toolbar's hide button + hint require a content-script
 * injection into a real page — covered by the SW-harness e2e, which loads the unpacked extension.)
 *
 * Run: `npm run build:web && npx playwright test e2e/loader-toolbar-shots.spec.ts`.
 */

const CHIA_URL = `chia://chia:${'a'.repeat(64)}/index.html`;

/** chrome.* stub for the fullscreen app shell with the DIG toolbar enabled + an unlocked wallet. */
function stub() {
  return `
(() => {
  const canned = (msg) => {
    const a = msg && msg.action;
    if (a === 'getLockState') return { lockState: 'unlocked', activeWalletId: 'w1', activeIndex: 0 };
    if (a === 'getCustodyBalances') return { balances: { xch: 0, cats: {} } };
    if (a === 'getActivity') return { events: [], cursorHeight: 0 };
    if (a === 'getDigNodeStatus') return { reachable: false, base: null };
    if (a === 'getDigDnsStatus') return { phase: 'unavailable' };
    return { success: true };
  };
  const store = { 'toolbar.enabled': true };
  const pick = (keys) => {
    if (keys == null) return { ...store };
    if (typeof keys === 'string') return store[keys] !== undefined ? { [keys]: store[keys] } : {};
    if (Array.isArray(keys)) { const o = {}; for (const k of keys) if (store[k] !== undefined) o[k] = store[k]; return o; }
    return { ...store };
  };
  window.chrome = {
    runtime: {
      id: 'loader-toolbar-shots', lastError: undefined,
      sendMessage: (msg, cb) => { const r = canned(msg); if (typeof cb === 'function') { cb(r); return; } return Promise.resolve(r); },
      getURL: (p) => p, onMessage: { addListener() {}, removeListener() {} }, openOptionsPage() {},
      getManifest: () => ({ version: '0.0.0-e2e' }),
    },
    storage: {
      local: {
        get: (keys, cb) => { const r = pick(keys); if (typeof cb === 'function') { cb(r); return; } return Promise.resolve(r); },
        set: (_o, cb) => { if (typeof cb === 'function') { cb(); return; } return Promise.resolve(); },
        remove: (_k, cb) => { if (typeof cb === 'function') { cb(); return; } return Promise.resolve(); },
      },
      session: { get: () => Promise.resolve({}), set: () => Promise.resolve() },
      onChanged: { addListener() {}, removeListener() {} },
    },
    tabs: { create() {} },
  };
})();
`;
}

const VIEWS = [
  ['desktop', { width: 1200, height: 860 }],
  ['mobile', { width: 390, height: 780 }],
] as const;

test.describe('#311 DIG loader page', () => {
  for (const scheme of ['light', 'dark'] as const) {
    for (const [label, size] of VIEWS) {
      test(`renders the branded shell + screenshot (${scheme}, ${label})`, async ({ page }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await page.setViewportSize(size);
        await page.goto(`/dig-loader.html?input=${encodeURIComponent(CHIA_URL)}`);
        await expect(page.getByTestId('dig-loader-page')).toBeVisible();
        await expect(page.getByTestId('dig-loader-spinner')).toBeVisible();
        await expect(page.getByTestId('dig-loader-address')).toContainText('Resolving');
        await page.waitForTimeout(150);
        await page.screenshot({ path: `e2e/__screenshots__/dig-loader-${scheme}-${label}.png` });
      });
    }
  }
});

test.describe('#366 built-in toolbar shortcut hint', () => {
  async function openApp(page: Page, size: { width: number; height: number }) {
    await page.setViewportSize(size);
    await page.addInitScript(stub());
    await page.goto('/app.html#home');
  }

  test('shows the show/hide shortcut hint (default until rebinding)', async ({ page }) => {
    await openApp(page, VIEWS[0][1]);
    const hint = page.getByTestId('builtin-dig-toolbar-shortcut-hint');
    await expect(hint).toBeVisible();
    await expect(hint).toContainText('Alt+Shift+D');
    await expect(hint).toContainText(/show\/hide/i);
  });

  for (const [label, size] of VIEWS) {
    test(`screenshot: built-in toolbar with hint (${label})`, async ({ page }) => {
      await openApp(page, size);
      await expect(page.getByTestId('builtin-dig-toolbar')).toBeVisible();
      await page.waitForTimeout(200);
      await page.screenshot({ path: `e2e/__screenshots__/builtin-toolbar-hint-${label}.png` });
    });
  }
});
