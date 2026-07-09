import { test, expect, chromium, type BrowserContext, type Worker, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

/**
 * END-USER e2e for #100 (multi-asset offers — >1 offered and/or >1 requested asset in one offer) —
 * driven against the BUILT unpacked extension in a real browser through the real self-custody
 * wallet + fullscreen UI (real clicks, not raw `chrome.runtime.sendMessage` calls). Mirrors the
 * cache-seeding technique in `trade-basic-surfaces.spec.ts` (a dead chain endpoint + a seeded
 * balance cache) so the multi-asset picks validate against a real, deterministic balance with no
 * live coinset dependency in CI.
 *
 * Proves: the fullscreen Make form's "+ Add another asset" control is reachable, composes a second
 * give leg, and reaches the guided review step showing BOTH legs — i.e. the #100 UI path is wired
 * end-to-end through the real popup/app shell, not just the Vitest component harness
 * (`tradePanel.test.tsx`). The exact multi-leg offer bundle (nonce/notarized-payments/phantom
 * carriers across N assets) is proven consensus-valid against the wasm Simulator in
 * `offers.test.ts`'s MULTI 1/2 cases — unchanged by this UI-only pass. Never auto-broadcasts.
 *
 * Run: `npm run build && npm run test:sw`.
 */

const EXT_PATH = resolve(process.cwd(), 'dist');
const GOLDEN = JSON.parse(readFileSync(resolve(process.cwd(), 'src/lib/keystore/derive.golden.json'), 'utf8')) as { mnemonic: string };
const PASSWORD = 'e2e-100-not-a-real-secret';

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let extensionId: string;
let worker: Worker;

function swSend<T>(page: Page, message: Record<string, unknown>): Promise<T> {
  return page.evaluate((msg) => new Promise<T>((res) => chrome.runtime.sendMessage(msg, res as (r: unknown) => void)), message);
}

async function unlockIfNeeded(page: Page): Promise<void> {
  await page.getByTestId('custody-gate').waitFor({ timeout: 20_000 });
  if (await page.getByTestId('custody-unlock').isVisible().catch(() => false)) {
    await page.getByTestId('unlock-password').fill(PASSWORD);
    await page.getByTestId('unlock-submit').click();
  }
  await page.getByTestId('custody-wallet').waitFor({ timeout: 20_000 });
}

async function openTrade(file: 'popup.html' | 'app.html', size: { width: number; height: number }): Promise<Page> {
  const page = await context.newPage();
  await page.setViewportSize(size);
  await page.goto(`chrome-extension://${extensionId}/${file}#wallet/trade`);
  await unlockIfNeeded(page);
  await page.getByTestId('custody-trade').waitFor();
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

  const anchor = await context.newPage();
  await anchor.goto(`chrome-extension://${extensionId}/popup.html`);
  const imported = await swSend<{ lockState?: string }>(anchor, { action: 'importWallet', mnemonic: GOLDEN.mnemonic, password: PASSWORD });
  expect(imported.lockState).toBe('unlocked');

  // A seeded XCH + $DIG balance (deterministic, no live coinset dependency) — enough distinct
  // assets for a second give/get leg to validate against real (non-zero) balances.
  await anchor.evaluate(() =>
    chrome.storage.local.set({
      'wallet.settings': { chainRpcUrl: 'http://127.0.0.1:1', chainPrivacyAck: true },
      'walletCache.balances': {
        balances: { xch: 1_000_000_000_000, cats: { d82dd03f8a19f0c7caff98f7c1957f2d90e07ba178b8d4c9d84a3a7db335e0d0: 5000 } },
        at: Date.now(),
      },
    }),
  );
  await anchor.close();
});

test.afterAll(async () => {
  await context?.close();
});

test('#100: fullscreen Make offers "+ Add another asset" on both give and get (advanced, fullscreen-only)', async () => {
  const page = await openTrade('app.html', { width: 1200, height: 860 });
  await expect(page.getByTestId('trade-give-add-asset')).toBeVisible();
  await expect(page.getByTestId('trade-get-add-asset')).toBeVisible();
  await page.close();
});

test('#100: the popup Make form has NO "add asset" controls (basic single-asset only)', async () => {
  const page = await openTrade('popup.html', { width: 372, height: 640 });
  await expect(page.getByTestId('trade-give-add-asset')).toHaveCount(0);
  await expect(page.getByTestId('trade-get-add-asset')).toHaveCount(0);
  await page.close();
});

test('#100: adding a second GIVE asset composes a 2-leg offer through to the review step', async () => {
  const page = await openTrade('app.html', { width: 1200, height: 860 });
  await page.getByTestId('trade-give-amount').fill('0.01'); // give row 0: XCH (asset idx 0)
  await page.getByTestId('trade-give-add-asset').click();
  // give row 1: the 3rd asset (idx 2, the seeded CAT) — the get side's default pick is idx 1 ($DIG,
  // always listed as a built-in row), so idx 2 is the one guaranteed NOT to collide with it (#100's
  // generalized SAME_ASSET check rejects any asset appearing on both sides).
  await page.getByTestId('trade-give-asset-1').selectOption('2');
  await page.getByTestId('trade-give-amount-1').fill('1');
  await page.getByTestId('trade-get-amount').fill('100');
  await page.getByTestId('trade-make-continue').click();

  const review = page.getByTestId('trade-make-review');
  await expect(review).toBeVisible();
  // Both legs' amounts appear in the "You give" summary (#100 — a joined multi-asset label).
  await expect(page.getByTestId('trade-make-review-give')).toContainText('0.01 XCH');
  await expect(page.getByTestId('trade-make-review-give')).toContainText('1 CAT');
  await page.close();
});

// Visual capture (§6.5) of the #100 fullscreen multi-asset builder, inspected for spacing/hierarchy.
test('screenshot: fullscreen Make with a second give-asset row added', async () => {
  const page = await openTrade('app.html', { width: 1200, height: 860 });
  await page.getByTestId('trade-give-amount').fill('0.01');
  await page.getByTestId('trade-give-add-asset').click();
  await page.getByTestId('trade-give-asset-1').selectOption('2'); // the 3rd asset — see the test above
  await page.getByTestId('trade-give-amount-1').fill('1');
  await page.getByTestId('trade-get-amount').fill('100');
  await page.waitForTimeout(250);
  await page.screenshot({ path: 'e2e/__screenshots__/fullscreen-trade-multi-asset.png' });
  await page.close();
});
