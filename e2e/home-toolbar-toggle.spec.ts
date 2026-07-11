import { test, expect, type Page } from '@playwright/test';

/**
 * END-USER e2e for #293 — the injected page-toolbar (#292) enable/disable switch, moved to the TOP
 * of the Home screen (popup/full-page), driven against the REAL built popup + fullscreen bundles
 * (`dist-web`) with a canned `chrome.*` stub whose `chrome.storage.local` round-trips through an
 * in-memory store AND fires `onChanged` (same pattern as `e2e/settings-prefs.spec.ts`) — proving the
 * switch persists the SAME `toolbar.enabled` key the content script (`dig-toolbar.ts`) reads live.
 *
 * Run: `npm run build:web && npx playwright test e2e/home-toolbar-toggle.spec.ts`.
 */

const TOOLBAR_ENABLED_KEY = 'toolbar.enabled';

/** chrome.* stub: an unlocked wallet with no balances, so Home renders the widget board fast. */
function stub(seed: Record<string, unknown> = {}) {
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
  const store = ${JSON.stringify(seed)};
  const changeListeners = new Set();
  const pick = (keys) => {
    if (keys == null) return { ...store };
    if (typeof keys === 'string') return store[keys] !== undefined ? { [keys]: store[keys] } : {};
    if (Array.isArray(keys)) { const o = {}; for (const k of keys) if (store[k] !== undefined) o[k] = store[k]; return o; }
    return { ...store };
  };
  window.chrome = {
    runtime: {
      id: 'home-toolbar-toggle-harness',
      sendMessage: (msg, cb) => { const r = canned(msg); if (typeof cb === 'function') { cb(r); return; } return Promise.resolve(r); },
      getURL: (p) => p,
      onMessage: { addListener() {}, removeListener() {} },
      openOptionsPage() {},
      getManifest: () => ({ version: '0.0.0-e2e' }),
    },
    storage: {
      local: {
        get: (keys, cb) => { const r = pick(keys); if (typeof cb === 'function') { cb(r); return; } return Promise.resolve(r); },
        set: (obj, cb) => {
          const changes = {};
          for (const k of Object.keys(obj)) { changes[k] = { oldValue: store[k], newValue: obj[k] }; store[k] = obj[k]; }
          changeListeners.forEach((fn) => { try { fn(changes, 'local'); } catch (e) {} });
          if (typeof cb === 'function') { cb(); return; } return Promise.resolve();
        },
        remove: (k, cb) => { delete store[k]; if (typeof cb === 'function') { cb(); return; } return Promise.resolve(); },
      },
      session: { get: () => Promise.resolve({}), set: () => Promise.resolve() },
      onChanged: { addListener: (fn) => changeListeners.add(fn), removeListener: (fn) => changeListeners.delete(fn) },
    },
    tabs: { create() {} },
  };
  window.__mockStorage = store;
})();
`;
}

async function open(page: Page, file: string, hash: string, seed: Record<string, unknown> = {}) {
  await page.addInitScript(stub(seed));
  await page.goto(`/${file}${hash}`);
}

test.describe('#293 Home-tab toolbar toggle', () => {
  test('is the FIRST widget on Home, defaults OFF, and toggling ON persists toolbar.enabled=true live', async ({ page }) => {
    await open(page, 'popup.html', '#home');
    await expect(page.getByTestId('home-screen')).toBeVisible();

    const widget = page.getByTestId('home-toolbar-toggle-widget');
    await expect(widget).toBeVisible();
    // Top of the Home screen — precedes the balance/quick-actions/status widget board.
    await expect(page.getByTestId('home-screen').locator(':scope > *').first()).toHaveAttribute(
      'data-testid',
      'home-toolbar-toggle-widget',
    );

    const checkbox = page.getByTestId('home-toolbar-toggle');
    await expect(checkbox).not.toBeChecked();
    await expect(page.getByTestId('home-toolbar-toggle-status')).toContainText(/inactive/i);

    await checkbox.click();
    await expect(checkbox).toBeChecked();
    await expect(page.getByTestId('home-toolbar-toggle-status')).toContainText(/active/i);

    const persisted = await page.evaluate(
      (key) => (window as unknown as { __mockStorage: Record<string, unknown> }).__mockStorage[key],
      TOOLBAR_ENABLED_KEY,
    );
    expect(persisted).toBe(true);
  });

  test('hydrates ON + toggling OFF persists toolbar.enabled=false', async ({ page }) => {
    await open(page, 'popup.html', '#home', { [TOOLBAR_ENABLED_KEY]: true });
    const checkbox = page.getByTestId('home-toolbar-toggle');
    await expect(checkbox).toBeChecked();

    await checkbox.click();
    await expect(checkbox).not.toBeChecked();
    const persisted = await page.evaluate(
      (key) => (window as unknown as { __mockStorage: Record<string, unknown> }).__mockStorage[key],
      TOOLBAR_ENABLED_KEY,
    );
    expect(persisted).toBe(false);
  });

  for (const [label, file, size] of [
    ['popup', 'popup.html', { width: 372, height: 640 }],
    ['fullscreen', 'app.html', { width: 1200, height: 860 }],
  ] as const) {
    test(`screenshot: toolbar toggle at the top of Home (${label})`, async ({ page }) => {
      await page.setViewportSize(size);
      await open(page, file, '#home');
      await expect(page.getByTestId('home-toolbar-toggle-widget')).toBeVisible();
      await page.waitForTimeout(200);
      await page.screenshot({ path: `e2e/__screenshots__/home-toolbar-toggle-${label}.png` });
    });
  }
});
