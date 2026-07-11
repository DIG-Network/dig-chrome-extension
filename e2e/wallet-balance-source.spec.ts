import { test, expect, type Page } from '@playwright/test';

/**
 * END-USER e2e for #399 — the wallet panel must render the connected self-custody wallet's REAL
 * (non-zero) XCH + $DIG even when a local dig-node is reachable. Regression trigger: a reachable node
 * answered balance reads from ITS OWN identity-less wallet (0 XCH / no CATs), so the panel showed
 * 0/0. After the fix, connected-wallet data comes from the self-custody scan (resolved wallet-data
 * source = coinset) while the node stays reachable for CONTENT only — so the panel shows the real
 * balance, never the node's 0/0.
 *
 * Drives the REAL built popup + fullscreen bundles (`dist-web`) with a canned `chrome.*` stub whose
 * `getCustodyBalances` returns what the self-custody scan yields (the post-fix source) and whose
 * `getDigNodeStatus` reports the node REACHABLE (the #399 trigger) + `getChainSourceStatus` reports
 * the resolved wallet-data source as `coinset` (self-custody, the shipped default until the #407
 * verified-tracking handshake). Same harness pattern as `e2e/home-balance.spec.ts`.
 *
 * Run: `npm run build:web && npx playwright test e2e/wallet-balance-source.spec.ts`.
 */

// $DIG TAIL (`src/lib/wallet-assets.ts` DIG_META); 3-decimal CAT → 4_200_000 base units = 4200 $DIG.
const DIG_ASSET_ID = 'a406d3a9de984d03c9591c10d917593b434d5263cabe2b42f6b367df16832f81';
const XCH_MOJOS = 2_510_000_000_000; // 2.51 XCH
const DIG_BASE_UNITS = 4_200_000; // 4200 $DIG

/** chrome.* stub: an unlocked self-custody wallet holding real XCH + $DIG, with a REACHABLE node. */
function stub() {
  return `
(() => {
  const canned = (msg) => {
    const a = msg && msg.action;
    if (a === 'getLockState') return { lockState: 'unlocked' };
    // The self-custody scan result (post-#399 source) — real non-zero XCH + $DIG.
    if (a === 'getCustodyBalances') return { balances: { xch: ${XCH_MOJOS}, cats: { '${DIG_ASSET_ID}': ${DIG_BASE_UNITS} } }, cached: false };
    if (a === 'getReceiveAddress') return { address: 'xch1qqqqwalletbalancesourcedemoqqqqqqqqqqqqqqqqqqqqqqqqqzzzz' };
    if (a === 'getActivity') return { events: [], cursorHeight: 0 };
    // #399 regression trigger: the node IS reachable — it just must not be the connected-wallet source.
    if (a === 'getDigNodeStatus') return { reachable: true, base: 'http://localhost:9778' };
    // Post-fix resolved wallet-data source: self-custody (coinset), not the reachable node.
    if (a === 'getChainSourceStatus') return { mode: 'auto', resolved: { kind: 'coinset' } };
    if (a === 'listWallets') return { wallets: [{ id: 'w1', active: true, kind: 'custody', label: 'Test' }] };
    if (a === 'getClawbacks') return { clawbacks: [] };
    return { success: true };
  };
  window.chrome = {
    runtime: {
      id: 'wallet-balance-source-harness',
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

async function openWallet(page: Page) {
  await mockPrices(page);
  await page.addInitScript(stub());
  await page.goto('/popup.html#home');
  await page.getByTestId('home-balance').click();
  await expect(page.getByTestId('custody-wallet')).toBeVisible();
}

test.describe('#399 wallet panel shows real balances (node reachable, self-custody source)', () => {
  test('XCH and $DIG render NON-ZERO — never the reachable node’s 0/0', async ({ page }) => {
    await openWallet(page);

    const xch = page.getByTestId('asset-xch');
    const dig = page.getByTestId('asset-dig');
    await expect(xch).toBeVisible();
    await expect(dig).toBeVisible();
    // Real, non-zero amounts from the self-custody scan.
    await expect(xch).toContainText('2.51');
    await expect(xch).toContainText('XCH');
    await expect(dig).toContainText('4200');
    await expect(dig).toContainText('$DIG');
    // Never a zero balance (the #399 symptom).
    await expect(xch).not.toContainText('0 XCH');
    await expect(dig).not.toContainText('0 $DIG');
  });

  // Visual capture (§6.5) — the wallet panel at phone (popup) + desktop (fullscreen) widths.
  for (const [label, file, size] of [
    ['mobile', 'popup.html', { width: 372, height: 640 }],
    ['desktop', 'app.html', { width: 1200, height: 860 }],
  ] as const) {
    test(`screenshot: wallet panel with real balances (${label})`, async ({ page }) => {
      await mockPrices(page);
      await page.setViewportSize(size);
      await page.addInitScript(stub());
      await page.goto(`/${file}#home`);
      await page.getByTestId('home-balance').click();
      const dig = page.getByTestId('asset-dig');
      await expect(dig).toContainText('$DIG');
      // Bring the XCH + $DIG asset rows into view (the popup scrolls its own container, so the
      // balance evidence would otherwise sit below the fold on the phone width).
      await dig.scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      await page.screenshot({ path: `e2e/__screenshots__/wallet-balance-source-${label}.png`, fullPage: true });
    });
  }
});
