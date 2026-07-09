import { test, expect, chromium, type BrowserContext, type Worker, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

/**
 * END-USER e2e for #101 (saved/active offer management + status) — driven against the BUILT
 * unpacked extension in a real browser through the real self-custody wallet + SW.
 *
 * Proves:
 *   1. `getOffers` is wired to the SW's offer-log glue (never the "unknown custody action" stub) and
 *      returns a real `{ offers: [] }` shape for a fresh wallet that has made nothing — deterministic
 *      in CI (no chain call happens when there are no OPEN entries to reconcile).
 *   2. The real fullscreen "Offers" tab renders that empty state through actual UI clicks.
 *   3. The popup "Offers" tab renders the SAME view — the local offer log is not a fullscreen-only
 *      READ (only its ACTIONS — copy/cancel — are fullscreen-only, per the module doc).
 *
 * Persisting a made offer (`makeOffer` → SW appends an offer-log entry) and the full cancel round
 * trip need a live coinset read to actually build a spend, which is unreachable in CI — those paths
 * are proven at the unit layer instead: `src/lib/offer-log.test.ts` (append/status-flip/ring-buffer),
 * `src/offscreen/vault.test.ts` (the vault surfaces `offerCoinIds`/`tradeKind` on the wire), and
 * `src/features/wallet/custody/OffersPanel.test.tsx` (the full copy/cancel/status UI, mocked SW).
 * This pass never auto-broadcasts a mainnet spend.
 *
 * Run: `npm run build && npm run test:sw`.
 */

const EXT_PATH = resolve(process.cwd(), 'dist');
const GOLDEN = JSON.parse(readFileSync(resolve(process.cwd(), 'src/lib/keystore/derive.golden.json'), 'utf8')) as { mnemonic: string };
const PASSWORD = 'e2e-101-not-a-real-secret';
const UNKNOWN_ACTION = 'unknown custody action';

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
  // Ack the balances-privacy banner (mirrors trade-basic-surfaces.spec.ts) so it doesn't push the
  // Offers tab content below the fold in the screenshot capture.
  await anchor.evaluate(() => chrome.storage.local.set({ 'wallet.settings': { chainPrivacyAck: true } }));
  await anchor.close();
});

test.afterAll(async () => {
  await context?.close();
});

test('#101: getOffers is wired to the SW (never the unknown-action stub) and is empty for a fresh wallet', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  const res = await swSend<{ offers?: unknown[]; message?: string }>(page, { action: 'getOffers' });
  expect(res.message).not.toBe(UNKNOWN_ACTION);
  expect(Array.isArray(res.offers)).toBe(true);
  expect(res.offers).toHaveLength(0);
  await page.close();
});

test('#101: fullscreen Trade → Offers tab shows the real empty state', async () => {
  const page = await openTrade('app.html', { width: 1200, height: 860 });
  await page.getByTestId('trade-mode-offers').click();
  await expect(page.getByTestId('offers-panel')).toBeVisible();
  await expect(page.getByTestId('offers-empty')).toBeVisible();
  await page.close();
});

test('#101: popup Trade → Offers tab shows the SAME empty state (the log itself is not fullscreen-gated)', async () => {
  const page = await openTrade('popup.html', { width: 372, height: 640 });
  await page.getByTestId('trade-mode-offers').click();
  await expect(page.getByTestId('offers-panel')).toBeVisible();
  await expect(page.getByTestId('offers-empty')).toBeVisible();
  await page.close();
});

// Visual capture (§6.5) of the #101 Offers tab (empty state), inspected for spacing/hierarchy.
test('screenshot: fullscreen + popup Offers tab (empty state)', async () => {
  const full = await openTrade('app.html', { width: 1200, height: 860 });
  await full.getByTestId('trade-mode-offers').click();
  await full.getByTestId('offers-empty').waitFor();
  await full.waitForTimeout(250);
  await full.screenshot({ path: 'e2e/__screenshots__/fullscreen-trade-offers-empty.png' });
  await full.close();

  const popup = await openTrade('popup.html', { width: 372, height: 640 });
  await popup.getByTestId('trade-mode-offers').click();
  await popup.getByTestId('offers-empty').waitFor();
  await popup.waitForTimeout(250);
  await popup.screenshot({ path: 'e2e/__screenshots__/popup-trade-offers-empty.png' });
  await popup.close();
});
