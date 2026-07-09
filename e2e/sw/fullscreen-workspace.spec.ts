import { test, expect, chromium, type BrowserContext, type Worker, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

/**
 * END-USER e2e for #85 — the professional desktop wallet WORKSPACE. Drives the BUILT unpacked
 * extension in a real browser: at a desktop width `app.html` must present a genuine desktop layout
 * (persistent sidebar + app-bar + width-using content), visibly distinct from the compact popup,
 * navigable entirely from the sidebar — the SAME self-custody wallet + RTK store powering both.
 *
 * Determinism: a wallet is imported from the golden mnemonic and a held XCH balance is supplied via
 * the SW cached-first path (`walletCache.balances`, chain pointed at a dead endpoint so the live
 * scan times out and the seeded snapshot is served). No network calls are required to render.
 *
 * Run: `npm run build && npm run test:sw`.
 */

const EXT_PATH = resolve(process.cwd(), 'dist');
const GOLDEN = JSON.parse(readFileSync(resolve(process.cwd(), 'src/lib/keystore/derive.golden.json'), 'utf8')) as { mnemonic: string };
const PASSWORD = 'e2e-85-not-a-real-secret';

const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 372, height: 640 };

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let extensionId: string;
let worker: Worker;
let anchor: Page;

function swSend<T>(page: Page, message: Record<string, unknown>): Promise<T> {
  return page.evaluate((msg) => new Promise<T>((res) => chrome.runtime.sendMessage(msg, res as (r: unknown) => void)), message);
}

/** Open `app.html` (the desktop workspace) at a desktop width, unlocking via the UI if needed. */
async function openWorkspace(hash = '#wallet'): Promise<Page> {
  const page = await context.newPage();
  await page.setViewportSize(DESKTOP);
  await page.goto(`chrome-extension://${extensionId}/app.html${hash}`);
  await page.getByTestId('custody-gate').waitFor({ timeout: 20_000 });
  if (await page.getByTestId('custody-unlock').isVisible().catch(() => false)) {
    await page.getByTestId('unlock-password').fill(PASSWORD);
    await page.getByTestId('unlock-submit').click();
  }
  await page.getByTestId('popup-root').waitFor({ timeout: 20_000 });
  return page;
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

  anchor = await context.newPage();
  await anchor.goto(`chrome-extension://${extensionId}/popup.html`);
  const imported = await swSend<{ lockState?: string }>(anchor, { action: 'importWallet', mnemonic: GOLDEN.mnemonic, password: PASSWORD });
  expect(imported.lockState).toBe('unlocked');

  await anchor.evaluate(() =>
    chrome.storage.local.set({
      'wallet.settings': { chainRpcUrl: 'http://127.0.0.1:1', chainPrivacyAck: true },
      'walletCache.balances': { balances: { xch: 2_500_000_000_000, cats: {} }, at: Date.now() },
    }),
  );
});

test.afterAll(async () => {
  await context?.close();
});

test('at desktop width app.html renders the expanded workspace: sidebar nav + app-bar, not the popup', async () => {
  const page = await openWorkspace();
  // The shell picks the expanded layout by width (§ app/layout).
  await expect(page.getByTestId('popup-root')).toHaveAttribute('data-layout', 'expanded');
  // Persistent sidebar with the flattened wallet sections.
  await expect(page.getByRole('navigation', { name: /sidebar navigation/i })).toBeVisible();
  for (const key of ['home', 'wallet', 'activity', 'trade', 'collectibles', 'apps', 'network']) {
    await expect(page.getByTestId(`nav-${key}`)).toBeVisible();
  }
  // The desktop app-bar titles the active section.
  await expect(page.getByTestId('wallet-topbar')).toBeVisible();
  // The compact popup's in-content segmented control is hidden here — the sidebar is the nav.
  await expect(page.getByTestId('seg-activity')).toBeHidden();
  await page.close();
});

test('the sidebar drives the SHARED route — each section renders its feature in the wide layout', async () => {
  const page = await openWorkspace();
  await page.getByTestId('custody-wallet').waitFor({ timeout: 20_000 });

  // Wallet overview → balances/assets are present and the section is marked current.
  await expect(page.getByTestId('nav-wallet')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('asset-xch')).toBeVisible({ timeout: 20_000 });

  // Activity.
  await page.getByTestId('nav-activity').click();
  await expect(page.getByTestId('custody-activity')).toBeVisible();
  await expect(page.getByTestId('nav-activity')).toHaveAttribute('aria-current', 'page');

  // Collectibles (NFT gallery).
  await page.getByTestId('nav-collectibles').click();
  await expect(page.getByTestId('collectibles-panel')).toBeVisible();

  // Offers / Trade.
  await page.getByTestId('nav-trade').click();
  await expect(page.getByTestId('custody-trade')).toBeVisible();

  // Back to the wallet, then exercise a wide-layout feature: open Send.
  await page.getByTestId('nav-wallet').click();
  await page.getByTestId('action-send').click();
  await expect(page.getByTestId('custody-send')).toBeVisible();
  await page.close();
});

test('the workspace content never overflows horizontally at desktop width (§6.6 spacing)', async () => {
  const page = await openWorkspace();
  await page.getByTestId('custody-wallet').waitFor({ timeout: 20_000 });
  const overflow = await page.getByTestId('popup-root').evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.close();
});

// Visual capture (§6.5) — the desktop workspace at desktop width AND the compact popup, so the
// two surfaces can be inspected side by side for spacing/alignment/hierarchy.
test('screenshot: desktop workspace (wallet + activity) and the compact popup', async () => {
  const wide = await openWorkspace();
  await wide.getByTestId('custody-wallet').waitFor({ timeout: 20_000 });
  await wide.waitForTimeout(400);
  await wide.screenshot({ path: 'e2e/__screenshots__/fullscreen-workspace-wallet.png' });
  await wide.getByTestId('nav-activity').click();
  await wide.getByTestId('custody-activity').waitFor();
  await wide.waitForTimeout(300);
  await wide.screenshot({ path: 'e2e/__screenshots__/fullscreen-workspace-activity.png' });
  await wide.close();

  const popup = await context.newPage();
  await popup.setViewportSize(PHONE);
  await popup.goto(`chrome-extension://${extensionId}/popup.html#wallet`);
  await popup.getByTestId('custody-wallet').waitFor({ timeout: 20_000 });
  await popup.waitForTimeout(400);
  await popup.screenshot({ path: 'e2e/__screenshots__/fullscreen-workspace-popup.png' });
  await popup.close();
});
