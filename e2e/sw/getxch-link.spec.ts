import { test, expect, chromium, type BrowserContext, type Worker, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

/**
 * END-USER e2e for #210 ("Get more" link next to XCH → chia.net/buy-xch), driven against the BUILT
 * unpacked extension in a real browser through the real self-custody wallet + popup UI — same
 * harness/determinism approach as `getdig-menu-and-fiat-currency.spec.ts` (a seeded
 * `walletCache.balances` snapshot).
 *
 * Unlike #202's $DIG multi-venue menu, the XCH row's "Get more ↗" is a single plain link to
 * `https://www.chia.net/buy-xch/` — no popover to open.
 *
 * Run: `npm run build && npm run test:sw`.
 */

const EXT_PATH = resolve(process.cwd(), 'dist');
const GOLDEN = JSON.parse(readFileSync(resolve(process.cwd(), 'src/lib/keystore/derive.golden.json'), 'utf8')) as { mnemonic: string };
const PASSWORD = 'e2e-210-getxch-not-a-real-secret';
const DIG_ASSET_ID = 'a406d3a9de984d03c9591c10d917593b434d5263cabe2b42f6b367df16832f81';
const GET_XCH_URL = 'https://www.chia.net/buy-xch/';

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let extensionId: string;
let worker: Worker;
let anchor: Page;

function swSend<T>(page: Page, message: Record<string, unknown>): Promise<T> {
  return page.evaluate((msg) => new Promise<T>((res) => chrome.runtime.sendMessage(msg, res as (r: unknown) => void)), message);
}

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

  await context.route('**/api.coingecko.com/api/v3/simple/price?ids=chia&vs_currencies=usd&**', (route) =>
    route.fulfill(json({ chia: { usd: 10, usd_24h_change: null } })),
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

test('#210 the "Get more" link on the XCH row points at chia.net/buy-xch and opens in a new tab', async () => {
  const page = await openWallet();
  await expect(page.getByTestId('asset-xch')).toBeVisible({ timeout: 25_000 });

  const link = page.getByTestId('asset-xch').getByTestId('getxch-link');
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('href', GET_XCH_URL);
  await expect(link).toHaveAttribute('target', '_blank');

  // No popover/menu — a plain link, unlike the $DIG row's 3-venue menu (#202).
  await expect(page.getByTestId('asset-dig').getByTestId('getxch-link')).toHaveCount(0);
  await page.close();
});

// Visual capture (§6.5) — the XCH row's "Get more" link, at phone (popup) + tablet (fullscreen) widths.
for (const [label, file, size] of [
  ['popup', 'popup.html', { width: 372, height: 640 }],
  ['fullscreen', 'app.html', { width: 1200, height: 860 }],
] as const) {
  test(`screenshot: "Get more" link on the XCH row (${label})`, async () => {
    const page = await openWallet(file, size);
    const xchRow = page.getByTestId('asset-xch');
    await xchRow.waitFor({ timeout: 25_000 });
    // The popup stacks a privacy note + total-balance card above Assets, so the row can sit below
    // the fold at popup width — scroll it into view so the capture actually shows what was built.
    await xchRow.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await page.screenshot({ path: `e2e/__screenshots__/getxch-link-${label}.png` });
    await page.close();
  });
}
