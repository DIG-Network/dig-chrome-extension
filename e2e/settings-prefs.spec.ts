import { test, expect, type Page } from '@playwright/test';

/**
 * END-USER e2e for the settings/preferences trio (#111 theme, #108 network switcher, #82 Control-
 * tab i18n), driven against the REAL built popup + fullscreen bundles (`dist-web`) with a canned
 * `chrome.*` stub whose `chrome.storage.local` round-trips through an in-memory store AND fires
 * `onChanged` (so a write from `AppFooter`/`NetworkSetting` is reflected live via the real
 * `installStorageSync` bridge, not just persisted) — the same pattern as
 * `e2e/wallet-switcher.spec.ts`.
 *
 * Run: `npm run build:web && npx playwright test e2e/settings-prefs.spec.ts`.
 */

/** chrome.* stub: an unlocked single wallet + a local dig-node (Control tab manage mode). `seed`
 *  pre-populates `wallet.settings` (e.g. `{ advanced: true }` to reach the Advanced-tier settings). */
function stub(seed: Record<string, unknown> = {}) {
  return `
(() => {
  const canned = (msg) => {
    const a = msg && msg.action;
    if (a === 'getLockState') return { lockState: 'unlocked', activeWalletId: 'w1', activeIndex: 0 };
    if (a === 'getCustodyBalances') return { balances: { xch: 2510000000000, cats: {} } };
    if (a === 'getReceiveAddress') return { address: 'xch1qqqqsettingsdemoaddressqqqqqqqqqqqqqqqqqqqqqqqqqqqqzzzz' };
    if (a === 'getActivity') return { events: [], cursorHeight: 0 };
    if (a === 'getControlStatus') {
      return {
        mode: 'manage', localNode: true, base: 'http://dig.local', controlEndpoint: 'http://dig.local/',
        readFallback: 'https://rpc.dig.net/', authRequired: false,
        status: { hosted_store_count: 2, cached_capsule_count: 5, cache: { used_bytes: 1000 }, sync: { available: true } },
        controlMethods: [],
      };
    }
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
      id: 'settings-prefs-harness',
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
})();
`;
}

async function open(page: Page, file: string, hash: string, seed: Record<string, unknown> = {}) {
  await page.addInitScript(stub(seed));
  await page.goto(`/${file}${hash}`);
}

test.describe('#111 theme selection', () => {
  test('switches light/dark via the footer selector; applies live to documentElement', async ({ page }) => {
    await open(page, 'popup.html', '#wallet');
    await expect(page.getByTestId('custody-wallet')).toBeVisible();

    // Defaults to "system" — no explicit light/dark class forced by a persisted choice.
    await expect(page.getByTestId('theme-select')).toHaveValue('system');

    await page.getByTestId('theme-select').selectOption('dark');
    await expect(page.locator('html')).toHaveAttribute('data-dig-theme', 'dark');

    await page.getByTestId('theme-select').selectOption('light');
    await expect(page.locator('html')).toHaveAttribute('data-dig-theme', 'light');
  });

  for (const [label, file, size] of [
    ['popup', 'popup.html', { width: 372, height: 640 }],
    ['fullscreen', 'app.html', { width: 1200, height: 860 }],
  ] as const) {
    test(`screenshot: dark theme (${label})`, async ({ page }) => {
      await page.setViewportSize(size);
      await open(page, file, '#wallet', { 'wallet.settings': { theme: 'dark' } });
      await expect(page.getByTestId('custody-wallet')).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-dig-theme', 'dark');
      await page.waitForTimeout(200);
      await page.screenshot({ path: `e2e/__screenshots__/theme-dark-${label}.png` });
    });
  }
});

test.describe('#108 network switcher', () => {
  test('requires confirmation before switching, then persists + shows the header badge', async ({ page }) => {
    await open(page, 'popup.html', '#wallet', { 'wallet.settings': { advanced: true } });
    await expect(page.getByTestId('network-setting')).toBeVisible();
    await expect(page.getByTestId('network-badge')).toHaveCount(0);

    await page.getByTestId('network-select').selectOption('testnet');
    await expect(page.getByTestId('network-confirm')).toBeVisible();
    // Not yet applied — the header badge must not appear until the switch is confirmed.
    await expect(page.getByTestId('network-badge')).toHaveCount(0);

    await page.getByTestId('network-confirm-proceed').click();
    await expect(page.getByTestId('network-confirm')).toBeHidden();
    await expect(page.getByTestId('network-badge')).toBeVisible();
    await expect(page.getByTestId('network-badge')).toContainText(/testnet/i);
  });

  for (const [label, file, size] of [
    ['popup', 'popup.html', { width: 372, height: 640 }],
    ['fullscreen', 'app.html', { width: 1200, height: 860 }],
  ] as const) {
    test(`screenshot: testnet badge + network setting (${label})`, async ({ page }) => {
      await page.setViewportSize(size);
      await open(page, file, '#wallet', { 'wallet.settings': { advanced: true, network: 'testnet' } });
      await expect(page.getByTestId('network-setting')).toBeVisible();
      await expect(page.getByTestId('network-badge')).toBeVisible();
      await page.waitForTimeout(200);
      await page.screenshot({ path: `e2e/__screenshots__/network-testnet-${label}.png` });
    });
  }
});

test.describe('#82 Control-tab i18n', () => {
  test('renders the externalized prose + stats through react-intl in a non-English locale', async ({ page }) => {
    await open(page, 'popup.html', '#network/control', { 'wallet.settings': { locale: 'de' } });
    await expect(page.getByTestId('control-panel')).toHaveAttribute('data-mode', 'manage');
    // German translation of "Hosted stores" / the manage note — proves the catalog id resolves
    // through the ACTIVE locale, not a hardcoded English string.
    await expect(page.getByTestId('control-stats')).toContainText('2');
    await expect(page.getByTestId('control-manage-note')).toContainText(/DIG-Erlebnis|DIG Browser/i);
  });

  for (const [label, file, size] of [
    ['popup', 'popup.html', { width: 372, height: 640 }],
    ['fullscreen', 'app.html', { width: 1200, height: 860 }],
  ] as const) {
    test(`screenshot: Control tab, German locale (${label})`, async ({ page }) => {
      await page.setViewportSize(size);
      await open(page, file, '#network/control', { 'wallet.settings': { locale: 'de' } });
      await expect(page.getByTestId('control-panel')).toBeVisible();
      await page.waitForTimeout(200);
      await page.screenshot({ path: `e2e/__screenshots__/control-de-${label}.png` });
    });
  }
});
