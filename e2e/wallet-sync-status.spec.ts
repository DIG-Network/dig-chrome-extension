import { test, expect, type Page } from '@playwright/test';

/**
 * END-USER e2e for #372/#373 — the first-class wallet SYNCING / DISCONNECTED UI driven by the
 * node's `sync_status` pushed over the `/ws` wallet+control transport (#372). Drives the REAL built
 * popup + fullscreen bundles (`dist-web`) with a canned `chrome.*` stub whose `getWalletSyncStatus`
 * returns each tri-state, and asserts the wallet surfaces it prominently:
 *   - syncing      → a "Syncing (peak/target)" banner + progress + a header pill (balances not final);
 *   - synced       → no banner, a "Synced" header pill (normal wallet);
 *   - disconnected → a DISCONNECTED alert banner labeling content offline/out-of-date.
 * Same harness pattern as `e2e/wallet-balance-source.spec.ts`.
 *
 * Run: `npm run build:web && npx playwright test e2e/wallet-sync-status.spec.ts`.
 */

const XCH_MOJOS = 2_510_000_000_000;

/** chrome.* stub: an unlocked wallet whose `getWalletSyncStatus` returns the given sync state. */
function stub(sync: { state: string; peakHeight: number | null; targetHeight: number | null }) {
  return `
(() => {
  const sync = ${JSON.stringify(sync)};
  const canned = (msg) => {
    const a = msg && msg.action;
    if (a === 'getLockState') return { lockState: 'unlocked' };
    if (a === 'getWalletSyncStatus') return { ...sync, updatedAt: 1 };
    if (a === 'getCustodyBalances') return { balances: { xch: ${XCH_MOJOS}, cats: {} }, cached: false };
    if (a === 'getReceiveAddress') return { address: 'xch1qqqqsyncstatusdemoqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqzzzz' };
    if (a === 'getActivity') return { events: [] };
    if (a === 'getDigNodeStatus') return { reachable: sync.state !== 'disconnected', base: 'http://localhost:9778' };
    if (a === 'getNodeLiveStatus') return { state: sync.state === 'disconnected' ? 'disconnected' : 'connected', base: 'http://localhost:9778', addr: '127.0.0.1:9778', version: '0.20.0', commit: 'abc', updatedAt: 1 };
    if (a === 'getChainSourceStatus') return { mode: 'auto', resolved: { kind: 'coinset' } };
    if (a === 'listWallets') return { wallets: [{ id: 'w1', active: true, kind: 'custody', label: 'Test' }] };
    if (a === 'getClawbacks') return { clawbacks: [] };
    return { success: true };
  };
  window.chrome = {
    runtime: {
      id: 'wallet-sync-status-harness',
      sendMessage: (msg, cb) => { const r = canned(msg); if (typeof cb === 'function') { cb(r); return; } return Promise.resolve(r); },
      getURL: (p) => p,
      onMessage: { addListener() {}, removeListener() {} },
      openOptionsPage() {},
      getManifest: () => ({ version: '0.0.0-e2e' }),
    },
    storage: {
      local: { get: () => Promise.resolve({}), set: () => Promise.resolve(), remove: () => Promise.resolve(), onChanged: { addListener() {}, removeListener() {} } },
      session: { get: () => Promise.resolve({}), set: () => Promise.resolve() },
      onChanged: { addListener() {}, removeListener() {} },
    },
    tabs: { create() {} },
  };
})();
`;
}

async function mockPrices(page: Page) {
  const json = (route: Parameters<Parameters<Page['route']>[1]>[0], body: unknown) =>
    route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
  await page.route('https://api.coingecko.com/**', (r) => json(r, { chia: { usd: 10, usd_24h_change: 0 } }));
  await page.route('https://api.dexie.space/**', (r) => json(r, { tickers: [] }));
}

async function openWallet(page: Page, sync: Parameters<typeof stub>[0]) {
  await mockPrices(page);
  await page.addInitScript(stub(sync));
  await page.goto('/popup.html#home');
  await page.getByTestId('home-balance').click();
  await expect(page.getByTestId('custody-wallet')).toBeVisible();
}

test.describe('#373 first-class wallet syncing / disconnected UI', () => {
  test('SYNCING → prominent banner with peak/target progress + header pill', async ({ page }) => {
    await openWallet(page, { state: 'syncing', peakHeight: 50, targetHeight: 200 });
    const banner = page.getByTestId('wallet-sync-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toHaveAttribute('data-state', 'syncing');
    await expect(page.getByTestId('wallet-sync-banner-detail')).toContainText('50');
    await expect(page.getByTestId('wallet-sync-banner-detail')).toContainText('200');
    await expect(page.getByTestId('wallet-sync-progress')).toHaveAttribute('aria-valuenow', '25');
    await expect(page.getByTestId('header-wallet-sync-pill')).toContainText(/sync/i);
  });

  test('SYNCED → no banner, a Synced header pill (normal wallet)', async ({ page }) => {
    await openWallet(page, { state: 'synced', peakHeight: 200, targetHeight: 200 });
    await expect(page.getByTestId('wallet-sync-banner')).toHaveCount(0);
    await expect(page.getByTestId('header-wallet-sync-pill')).toContainText(/synced/i);
  });

  test('DISCONNECTED → alert banner labeling content offline/out-of-date', async ({ page }) => {
    await openWallet(page, { state: 'disconnected', peakHeight: null, targetHeight: null });
    const banner = page.getByTestId('wallet-sync-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toHaveAttribute('data-state', 'disconnected');
    await expect(banner).toHaveAttribute('role', 'alert');
    await expect(page.getByTestId('wallet-sync-banner-detail')).toContainText(/cache|offline|out of date/i);
    await expect(page.getByTestId('wallet-sync-progress')).toHaveCount(0);
  });

  // Visual capture (§6.5) — the syncing + disconnected states at phone (popup) + desktop (fullscreen).
  for (const state of ['syncing', 'disconnected'] as const) {
    for (const [label, file, size] of [
      ['mobile', 'popup.html', { width: 372, height: 640 }],
      ['desktop', 'app.html', { width: 1200, height: 860 }],
    ] as const) {
      test(`screenshot: ${state} wallet (${label})`, async ({ page }) => {
        const sync = state === 'syncing'
          ? { state, peakHeight: 50, targetHeight: 200 }
          : { state, peakHeight: null, targetHeight: null };
        await mockPrices(page);
        await page.setViewportSize(size);
        await page.addInitScript(stub(sync));
        await page.goto(`/${file}#home`);
        await page.getByTestId('home-balance').click();
        await expect(page.getByTestId('wallet-sync-banner')).toBeVisible();
        // The compact popup is a fixed 600px phone whose `.dig-main` scrolls; a cross-tab click can
        // leave it scrolled — pin it to the top so the banner (the first element) is in frame.
        await page.evaluate(() => { document.querySelector('.dig-main')?.scrollTo(0, 0); });
        await page.getByTestId('wallet-sync-banner').scrollIntoViewIfNeeded();
        await page.waitForTimeout(300);
        await page.screenshot({ path: `e2e/__screenshots__/wallet-sync-${state}-${label}.png`, fullPage: true });
      });
    }
  }
});
