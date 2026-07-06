import { test, expect, type Page } from '@playwright/test';

/**
 * END-USER e2e for #86 — the fiat price feed + portfolio value, driven against the REAL built popup
 * bundle (dist-web) with DETERMINISTIC prices. The wallet's own reads (lock state, balances, receive
 * address) are answered by a canned `chrome.*` stub (a fixed 2 XCH + 10 $DIG holding); the two price
 * SOURCES (CoinGecko + dexie) are intercepted via `page.route`, so the fiat math is fully
 * reproducible in CI with no live market. This exercises the real RTK Query price slice + real
 * `fetch`, only the network responses are mocked.
 *
 * Run: `npm run build:web && npx playwright test e2e/prices.spec.ts`.
 */

const DIG_ASSET_ID = 'a406d3a9de984d03c9591c10d917593b434d5263cabe2b42f6b367df16832f81';

/** chrome.* stub: an unlocked wallet holding 2 XCH + 10.000 $DIG (balances via the SW seam). */
const STUB = `
(() => {
  const canned = (msg) => {
    const a = msg && msg.action;
    if (a === 'getLockState') return { lockState: 'unlocked' };
    if (a === 'getCustodyBalances') return { balances: { xch: 2000000000000, cats: { '${DIG_ASSET_ID}': 10000 } } };
    if (a === 'getReceiveAddress') return { address: 'xch1qqqqdigpricedemoaddressqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqzzzz' };
    if (a === 'getActivity') return { events: [], cursorHeight: 0 };
    return { success: true };
  };
  const store = {};
  window.chrome = {
    runtime: {
      id: 'price-harness',
      sendMessage: (msg, cb) => { const r = canned(msg); if (typeof cb === 'function') { cb(r); return; } return Promise.resolve(r); },
      getURL: (p) => p,
      onMessage: { addListener() {}, removeListener() {} },
      openOptionsPage() {},
      getManifest: () => ({ version: '0.0.0-e2e' }),
    },
    storage: {
      local: {
        get: (keys, cb) => { const r = {}; if (typeof cb === 'function') { cb(r); return; } return Promise.resolve(r); },
        set: (o, cb) => { Object.assign(store, o); if (typeof cb === 'function') { cb(); return; } return Promise.resolve(); },
        remove: () => Promise.resolve(),
        onChanged: { addListener() {}, removeListener() {} },
      },
      session: { get: () => Promise.resolve({}), set: () => Promise.resolve() },
      onChanged: { addListener() {}, removeListener() {} },
    },
    tabs: { create() {} },
  };
})();
`;

/** Fulfill a CORS-enabled JSON response (the popup fetches these cross-origin from 127.0.0.1). */
function json(route: Parameters<Parameters<Page['route']>[1]>[0], body: unknown) {
  return route.fulfill({
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify(body),
  });
}

async function openWallet(page: Page) {
  await page.addInitScript(STUB);
  await page.goto('/popup.html#wallet');
}

test.describe('#86 fiat price feed', () => {
  test('renders total fiat, a 24h delta, and per-asset fiat (prices mocked)', async ({ page }) => {
    // XCH = $10 (down 5%); $DIG = 0.05 XCH → $0.50.
    await page.route('https://api.coingecko.com/**', (r) => json(r, { chia: { usd: 10, usd_24h_change: -5 } }));
    await page.route('https://api.dexie.space/**', (r) =>
      json(r, { tickers: [{ base_id: DIG_ASSET_ID, target_id: 'xch', target_code: 'XCH', last_price: '0.05' }] }),
    );
    await openWallet(page);

    // Total: 2 XCH × $10 + 10 $DIG × $0.50 = $25.00.
    await expect(page.getByTestId('portfolio-value')).toHaveText('$25.00');

    // 24h delta chip: only XCH carries a change (−5%), marked down.
    const change = page.getByTestId('portfolio-change');
    await expect(change).toBeVisible();
    await expect(change).toHaveAttribute('data-direction', 'down');
    await expect(change).toContainText('5.00%');

    // Per-asset fiat.
    await expect(page.getByTestId('asset-xch-fiat')).toContainText('$20.00');
    await expect(page.getByTestId('asset-dig-fiat')).toContainText('$5.00');
  });

  // Visual capture (§6.5) — the priced wallet at phone (popup) + tablet (fullscreen) widths.
  for (const [label, file, size] of [
    ['popup', 'popup.html', { width: 372, height: 640 }],
    ['fullscreen', 'app.html', { width: 1200, height: 860 }],
  ] as const) {
    test(`screenshot: priced wallet (${label})`, async ({ page }) => {
      await page.route('https://api.coingecko.com/**', (r) => json(r, { chia: { usd: 10, usd_24h_change: -5 } }));
      await page.route('https://api.dexie.space/**', (r) =>
        json(r, { tickers: [{ base_id: DIG_ASSET_ID, target_id: 'xch', target_code: 'XCH', last_price: '0.05' }] }),
      );
      await page.setViewportSize(size);
      await page.addInitScript(STUB);
      await page.goto(`/${file}#wallet`);
      await expect(page.getByTestId('portfolio-change')).toBeVisible();
      await page.waitForTimeout(300);
      await page.screenshot({ path: `e2e/__screenshots__/wallet-prices-${label}.png` });
    });
  }

  test('degrades gracefully to "value unavailable" when prices fail (balances still render)', async ({ page }) => {
    await page.route('https://api.coingecko.com/**', (r) => r.abort());
    await page.route('https://api.dexie.space/**', (r) => r.abort());
    await openWallet(page);

    // The native balance still shows (2 XCH) — the wallet is never blocked by a price outage.
    await expect(page.getByTestId('portfolio-value')).toContainText('2');
    await expect(page.getByTestId('portfolio-status')).toBeVisible();
    await expect(page.getByTestId('portfolio-change')).toHaveCount(0);
    // Per-asset fiat shows the honest "unavailable" line, not a fabricated number.
    await expect(page.getByTestId('asset-xch-fiat')).toContainText('$—');
  });
});
