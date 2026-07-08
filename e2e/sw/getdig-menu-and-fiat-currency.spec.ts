import { test, expect, chromium, type BrowserContext, type Worker, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

/**
 * END-USER e2e for #202 ("Get more $DIG" venue menu) + #112 (fiat currency preference), driven
 * against the BUILT unpacked extension in a real browser through the real self-custody wallet +
 * popup UI — same harness/determinism approach as `asset-list-order-filter.spec.ts` (a seeded
 * `walletCache.balances` snapshot + mocked CoinGecko/dexie market data via Playwright routing).
 *
 * Holdings: XCH (2) + $DIG (10, $5 @ $10/XCH anchor). #202's Get-more trigger sits on the $DIG row
 * and opens the 3 canonical venues (TibetSwap → dexie → 9mm.pro), matching `GET_DIG_SOURCES`. #112's
 * currency picker reformats the portfolio total + every per-asset fiat line once a non-USD currency
 * is chosen and its exchange rate resolves.
 *
 * Run: `npm run build && npm run test:sw`.
 */

const EXT_PATH = resolve(process.cwd(), 'dist');
const GOLDEN = JSON.parse(readFileSync(resolve(process.cwd(), 'src/lib/keystore/derive.golden.json'), 'utf8')) as { mnemonic: string };
const PASSWORD = 'e2e-202-112-not-a-real-secret';
const DIG_ASSET_ID = 'a406d3a9de984d03c9591c10d917593b434d5263cabe2b42f6b367df16832f81';

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let extensionId: string;
let worker: Worker;
let anchor: Page;

function swSend<T>(page: Page, message: Record<string, unknown>): Promise<T> {
  return page.evaluate((msg) => new Promise<T>((res) => chrome.runtime.sendMessage(msg, res as (r: unknown) => void)), message);
}

/**
 * Open a surface on the Wallet tab, unlocking via the UI if it lands on the unlock screen. The
 * vault auto-locks on OS/browser idle (`chrome.idle.onStateChanged`, background/index.ts) — a real
 * risk across a MULTI-PAGE serial spec like this one, so every page open (including screenshots)
 * defensively re-enters the password rather than assuming the session is still unlocked.
 */
async function openWallet(file: 'popup.html' | 'app.html' = 'popup.html', viewport?: { width: number; height: number }): Promise<Page> {
  const page = await context.newPage();
  if (viewport) await page.setViewportSize(viewport);
  await page.goto(`chrome-extension://${extensionId}/${file}#wallet`);
  await page.getByTestId('custody-gate').waitFor({ timeout: 20_000 });
  if (await page.getByTestId('custody-unlock').isVisible().catch(() => false)) {
    await page.getByTestId('unlock-password').fill(PASSWORD);
    await page.getByTestId('unlock-submit').click();
  }
  await page.getByTestId('custody-wallet').waitFor({ timeout: 20_000 });
  return page;
}

function json(body: unknown) {
  return { status: 200, contentType: 'application/json', body: JSON.stringify(body) };
}

test.beforeAll(async () => {
  if (!existsSync(resolve(EXT_PATH, 'manifest.json'))) {
    throw new Error(`Built extension not found at ${EXT_PATH} — run \`npm run build\` before the e2e.`);
  }
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    args: ['--headless=new', `--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`],
  });
  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extensionId = worker.url().split('/')[2];

  // XCH = $10; $DIG = 0.05 XCH each → 10 × $0.50 = $5. The fiat exchange-rate source (CoinGecko,
  // widened to more vs_currencies) reports 1 USD = 0.9 EUR for the currency-preference proof below.
  await context.route('**/api.coingecko.com/api/v3/simple/price?ids=chia&vs_currencies=usd&**', (route) =>
    route.fulfill(json({ chia: { usd: 10, usd_24h_change: null } })),
  );
  await context.route('**/api.coingecko.com/api/v3/simple/price?ids=chia&vs_currencies=usd,eur**', (route) =>
    route.fulfill(json({ chia: { usd: 10, eur: 9 } })),
  );
  await context.route('**/api.dexie.space/v2/prices/tickers*', (route) =>
    route.fulfill(json({ tickers: [{ base_id: DIG_ASSET_ID, target_id: 'xch', last_price: '0.05' }] })),
  );
  await context.route('**/api.dexie.space/v1/swap/tokens*', (route) => route.fulfill(json({ success: true, tokens: [] })));

  anchor = await context.newPage();
  await anchor.goto(`chrome-extension://${extensionId}/popup.html`);
  const imported = await swSend<{ lockState?: string }>(anchor, { action: 'importWallet', mnemonic: GOLDEN.mnemonic, password: PASSWORD });
  expect(imported.lockState).toBe('unlocked');

  await anchor.evaluate(
    ({ digId }) =>
      chrome.storage.local.set({
        'wallet.settings': { chainRpcUrl: 'http://127.0.0.1:1', chainPrivacyAck: true },
        'walletCache.balances': {
          balances: { xch: 2_000_000_000_000, cats: { [digId]: 10_000 } },
          at: Date.now(),
        },
      }),
    { digId: DIG_ASSET_ID },
  );
});

test.afterAll(async () => {
  await context?.close();
});

test('#202 the "Get more" trigger on the $DIG row opens the 3 canonical venues, in order, with the correct URLs', async () => {
  const page = await openWallet();
  await expect(page.getByTestId('asset-dig')).toBeVisible({ timeout: 25_000 });

  await page.getByTestId('getdig-trigger').click();
  const menu = page.getByTestId('getdig-menu');
  await expect(menu).toBeVisible();

  const links = menu.getByRole('menuitem');
  await expect(links).toHaveCount(3);
  expect(await links.allTextContents()).toEqual([
    expect.stringContaining('TibetSwap'),
    expect.stringContaining('dexie'),
    expect.stringContaining('9mm.pro'),
  ]);
  expect(await links.nth(0).getAttribute('href')).toBe('https://v2.tibetswap.io/');
  expect(await links.nth(1).getAttribute('href')).toBe(`https://dexie.space/offers/${DIG_ASSET_ID}/XCH`);
  expect(await links.nth(2).getAttribute('href')).toBe(`https://xch.9mm.pro/token/${DIG_ASSET_ID}`);
  await page.close();
});

test('#112 picking a currency reformats the portfolio total + per-asset fiat lines', async () => {
  const page = await openWallet();
  await expect(page.getByTestId('portfolio-value')).toHaveText('$25.00', { timeout: 25_000 });

  await page.getByTestId('fiat-currency-select').selectOption('eur');
  // $25.00 total × 0.9 eur/usd = €22.50; $DIG's $5.00 row × 0.9 = €4.50.
  await expect(page.getByTestId('portfolio-value')).toHaveText('€22.50', { timeout: 10_000 });
  await expect(page.getByTestId('asset-dig-fiat')).toHaveText('≈ €4.50');
  await page.close();
});

// Visual capture (§6.5) — the $DIG row's open Get-more menu + the currency-converted portfolio, at
// phone (popup) + tablet (fullscreen) widths.
for (const [label, file, size] of [
  ['popup', 'popup.html', { width: 372, height: 640 }],
  ['fullscreen', 'app.html', { width: 1200, height: 860 }],
] as const) {
  test(`screenshot: "Get more $DIG" menu open (${label})`, async () => {
    const page = await openWallet(file, size);
    await page.getByTestId('asset-dig').waitFor({ timeout: 25_000 });
    await page.getByTestId('getdig-trigger').click();
    await page.getByTestId('getdig-menu').waitFor();
    await page.waitForTimeout(200);
    await page.screenshot({ path: `e2e/__screenshots__/getdig-menu-${label}.png` });
    await page.close();
  });

  test(`screenshot: EUR-converted portfolio (${label})`, async () => {
    const page = await openWallet(file, size);
    await page.getByTestId('portfolio-value').waitFor({ timeout: 25_000 });
    await page.getByTestId('fiat-currency-select').selectOption('eur');
    await page.getByTestId('portfolio-value').getByText('€', { exact: false }).waitFor({ timeout: 10_000 });
    await page.waitForTimeout(200);
    await page.screenshot({ path: `e2e/__screenshots__/fiat-currency-eur-${label}.png` });
    await page.close();
  });
}
