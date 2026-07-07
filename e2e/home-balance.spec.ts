import { test, expect, type Page } from '@playwright/test';

/**
 * END-USER e2e for #156 — the Home wallet-balance $ ⇄ XCH swap toggle, driven against the REAL
 * built popup + fullscreen bundles (`dist-web`) with a deterministic price (mocked CoinGecko/dexie,
 * same pattern as `e2e/prices.spec.ts`) and a canned `chrome.*` stub. Unlike that stub, THIS one's
 * `chrome.storage.local` actually round-trips through an in-memory `store`, so the persisted
 * display-unit preference can be proven to survive a popup close/reopen (a fresh page load re-reads
 * whatever was left in the seeded store) — not just to be written.
 *
 * Run: `npm run build:web && npx playwright test e2e/home-balance.spec.ts`.
 */

const STORAGE_KEY = 'wallet.homeBalanceUnit';

/** chrome.* stub: an unlocked wallet holding 2.51 XCH. `seed` pre-populates chrome.storage.local
 *  (simulating "the preference was already set on a previous visit"). */
function stub(seed: Record<string, unknown> = {}) {
  return `
(() => {
  const canned = (msg) => {
    const a = msg && msg.action;
    if (a === 'getLockState') return { lockState: 'unlocked' };
    if (a === 'getCustodyBalances') return { balances: { xch: 2510000000000, cats: {} } };
    if (a === 'getReceiveAddress') return { address: 'xch1qqqqhomebalancedemoaddressqqqqqqqqqqqqqqqqqqqqqqqqqqzzzz' };
    if (a === 'getActivity') return { events: [], cursorHeight: 0 };
    if (a === 'getDigNodeStatus') return { reachable: false, base: null };
    return { success: true };
  };
  const store = ${JSON.stringify(seed)};
  window.chrome = {
    runtime: {
      id: 'home-balance-harness',
      sendMessage: (msg, cb) => { const r = canned(msg); if (typeof cb === 'function') { cb(r); return; } return Promise.resolve(r); },
      getURL: (p) => p,
      onMessage: { addListener() {}, removeListener() {} },
      openOptionsPage() {},
      getManifest: () => ({ version: '0.0.0-e2e' }),
    },
    storage: {
      local: {
        get: (key, cb) => {
          const out = (typeof key === 'string' && key in store) ? { [key]: store[key] } : {};
          if (typeof cb === 'function') { cb(out); return; }
          return Promise.resolve(out);
        },
        set: (o, cb) => { Object.assign(store, o); if (typeof cb === 'function') { cb(); return; } return Promise.resolve(); },
        remove: () => Promise.resolve(),
        onChanged: { addListener() {}, removeListener() {} },
      },
      session: { get: () => Promise.resolve({}), set: () => Promise.resolve() },
      onChanged: { addListener() {}, removeListener() {} },
    },
    tabs: { create() {} },
  };
  window.__mockStorage = store;
})();
`;
}

function json(route: Parameters<Parameters<Page['route']>[1]>[0], body: unknown) {
  return route.fulfill({
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify(body),
  });
}

async function mockPrices(page: Page) {
  // XCH = $10 flat, no CAT tickers — 2.51 XCH → $25.10.
  await page.route('https://api.coingecko.com/**', (r) => json(r, { chia: { usd: 10, usd_24h_change: 0 } }));
  await page.route('https://api.dexie.space/**', (r) => json(r, { tickers: [] }));
}

test.describe('#156 Home balance $ ⇄ XCH swap', () => {
  test('defaults to XCH prominent with the USD equivalent shown small, then the swap button flips it', async ({ page }) => {
    await mockPrices(page);
    await page.addInitScript(stub());
    await page.goto('/popup.html#home');

    const value = page.getByTestId('home-balance-value');
    const secondary = page.getByTestId('home-balance-secondary');
    await expect(value).toHaveText('2.51 XCH');
    await expect(secondary).toContainText('25.10');

    await page.getByTestId('home-balance-swap').click();

    await expect(value).toContainText('25.10');
    await expect(secondary).toContainText('2.51 XCH');
  });

  test('clicking the swap button does not navigate to the Wallet tab', async ({ page }) => {
    await mockPrices(page);
    await page.addInitScript(stub());
    await page.goto('/popup.html#home');

    await page.getByTestId('home-balance-swap').click();
    // Still on Home — the swap is a sibling control, not the balance's own tap target.
    await expect(page.getByTestId('home-screen')).toBeVisible();
    await expect(page.getByTestId('home-balance-swap')).toBeVisible();
  });

  test('tapping the balance itself still opens the Wallet tab', async ({ page }) => {
    await mockPrices(page);
    await page.addInitScript(stub());
    await page.goto('/popup.html#home');

    await page.getByTestId('home-balance').click();
    await expect(page.getByTestId('custody-wallet')).toBeVisible();
  });

  test('the chosen unit persists across a popup close/reopen', async ({ page }) => {
    await mockPrices(page);
    await page.addInitScript(stub());
    await page.goto('/popup.html#home');

    await page.getByTestId('home-balance-swap').click();
    await expect(page.getByTestId('home-balance-value')).toContainText('25.10');

    // Read back what got persisted to the mocked chrome.storage.local, then simulate the popup
    // being closed and reopened by loading a FRESH page seeded with that persisted value (a real
    // chrome.storage.local durably survives a popup close; this in-memory mock does not, so the
    // seed stands in for "the value that was already on disk").
    const persisted = await page.evaluate((key) => (window as unknown as { __mockStorage: Record<string, unknown> }).__mockStorage[key], STORAGE_KEY);
    expect(persisted).toBe('usd');

    const page2 = await page.context().newPage();
    await mockPrices(page2);
    await page2.addInitScript(stub({ [STORAGE_KEY]: persisted }));
    await page2.goto('/popup.html#home');
    await expect(page2.getByTestId('home-balance-value')).toContainText('25.10');
    await page2.close();
  });

  test('degrades gracefully when the price feed fails: shows XCH, never a broken "$—"', async ({ page }) => {
    await page.route('https://api.coingecko.com/**', (r) => r.abort());
    await page.route('https://api.dexie.space/**', (r) => r.abort());
    await page.addInitScript(stub({ [STORAGE_KEY]: 'usd' }));
    await page.goto('/popup.html#home');

    const value = page.getByTestId('home-balance-value');
    await expect(value).toHaveText('2.51 XCH');
    await expect(value).not.toContainText('$');
    await expect(page.getByTestId('home-balance-secondary')).toBeVisible();
  });

  // Visual capture (§6.5) — the balance swap at phone (popup) + tablet (fullscreen) widths.
  for (const [label, file, size] of [
    ['popup', 'popup.html', { width: 372, height: 640 }],
    ['fullscreen', 'app.html', { width: 1200, height: 860 }],
  ] as const) {
    test(`screenshot: balance swap, USD prominent (${label})`, async ({ page }) => {
      await mockPrices(page);
      await page.setViewportSize(size);
      await page.addInitScript(stub({ [STORAGE_KEY]: 'usd' }));
      await page.goto(`/${file}#home`);
      await expect(page.getByTestId('home-balance-value')).toContainText('25.10');
      await page.waitForTimeout(300);
      await page.screenshot({ path: `e2e/__screenshots__/home-balance-swap-${label}.png` });
    });
  }
});
