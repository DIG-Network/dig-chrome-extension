import { test, expect, chromium, type BrowserContext, type Worker, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

/**
 * END-USER e2e for #169 (Trade panel UX clarity redesign + basic maker/taker in the popup) —
 * driven against the BUILT unpacked extension in a real browser through the real self-custody
 * wallet + popup/fullscreen UI (real clicks, not raw `chrome.runtime.sendMessage` calls).
 *
 * #169 refines #145: a BASIC maker/taker now renders on the COMPACT POPUP surface (previously the
 * popup showed only a dead-end "open full screen" card). This proves, against the real build:
 *   1. The popup Trade tab renders the WORKING mode tabs + make/take forms (not the old redirect),
 *      and hides the ADVANCED NFT give-kind toggle (still fullscreen-only, #94).
 *   2. The guided "You give / You get" REVIEW step (the #169 clarity redesign) is reachable in the
 *      real popup with a real (cached) balance — no live coinset read needed to validate the pick,
 *      mirroring the cache-seeding technique in view-header-receive.spec.ts (`wallet.settings`
 *      pointed at a dead RPC + `chainPrivacyAck` so the balances query resolves from the seeded
 *      cache instead of hanging on an unreachable coinset in CI).
 *   3. The popup basic Take path (paste → inspect) reaches the REAL offscreen vault's `inspectOffer`
 *      decode path (a real, non-stub decode error for a non-decodable string) — the same guard
 *      `offers.spec.ts` proves at the message layer, now proven through real UI clicks.
 *   4. Fullscreen keeps the ADVANCED NFT give-kind toggle; the popup does not — the #169 tiering
 *      split rendered correctly in the real build.
 *
 * Money-path correctness (the exact built offer structure, royalty enforcement, etc.) is proven
 * deterministically at the engine layer against the wasm Simulator in offers.test.ts — unchanged by
 * this UX-only issue. This pass never auto-broadcasts a mainnet spend.
 *
 * Run: `npm run build && npm run test:sw`.
 */

const EXT_PATH = resolve(process.cwd(), 'dist');
const GOLDEN = JSON.parse(readFileSync(resolve(process.cwd(), 'src/lib/keystore/derive.golden.json'), 'utf8')) as { mnemonic: string };
const PASSWORD = 'e2e-169-not-a-real-secret';

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let extensionId: string;
let worker: Worker;

function swSend<T>(page: Page, message: Record<string, unknown>): Promise<T> {
  return page.evaluate((msg) => new Promise<T>((res) => chrome.runtime.sendMessage(msg, res as (r: unknown) => void)), message);
}

/** Unlock via the UI if the page lands on the unlock screen (a fresh nav/reload re-checks lock state). */
async function unlockIfNeeded(page: Page): Promise<void> {
  await page.getByTestId('custody-gate').waitFor({ timeout: 20_000 });
  if (await page.getByTestId('custody-unlock').isVisible().catch(() => false)) {
    await page.getByTestId('unlock-password').fill(PASSWORD);
    await page.getByTestId('unlock-submit').click();
  }
  await page.getByTestId('custody-wallet').waitFor({ timeout: 20_000 });
}

/** Open the popup/fullscreen directly on the Trade sub-view, unlocking via the UI as needed. */
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

  // Point the chain at a dead endpoint + ack privacy (mirrors view-header-receive.spec.ts) so the
  // balances query resolves from this SEEDED cache instantly instead of hanging on an unreachable
  // live coinset read in CI — a real (positive, non-zero) balance the give-amount check validates
  // against, deterministically, with no network dependency.
  await anchor.evaluate(
    () =>
      chrome.storage.local.set({
        'wallet.settings': { chainRpcUrl: 'http://127.0.0.1:1', chainPrivacyAck: true },
        'walletCache.balances': { balances: { xch: 1_000_000_000_000, cats: {} }, at: Date.now() },
      }),
  );
  await anchor.close();
});

test.afterAll(async () => {
  await context?.close();
});

test('#169: popup Trade shows a WORKING basic make/take surface, not the old dead-end redirect card', async () => {
  const page = await openTrade('popup.html', { width: 372, height: 640 });
  await expect(page.getByTestId('trade-mode-make')).toBeVisible();
  await expect(page.getByTestId('trade-mode-take')).toBeVisible();
  await expect(page.getByTestId('trade-make-form')).toBeVisible();
  // The persistent "open full screen" link for anything beyond basic (#169) is still offered.
  await expect(page.getByTestId('trade-open-fullscreen')).toBeVisible();
  await page.close();
});

test('#169: popup Make hides the ADVANCED NFT give-kind toggle (currency-only basic maker)', async () => {
  const page = await openTrade('popup.html', { width: 372, height: 640 });
  await expect(page.getByTestId('trade-give-kind-currency')).toHaveCount(0);
  await expect(page.getByTestId('trade-give-kind-nft')).toHaveCount(0);
  await expect(page.getByTestId('trade-give-asset')).toBeVisible();
  await page.close();
});

test('#169: fullscreen Make keeps the ADVANCED NFT give-kind toggle', async () => {
  const page = await openTrade('app.html', { width: 1200, height: 860 });
  await expect(page.getByTestId('trade-give-kind-currency')).toBeVisible();
  await expect(page.getByTestId('trade-give-kind-nft')).toBeVisible();
  await page.close();
});

test('#169: popup basic Make reaches the "You give / You get" review with a real (cached) balance', async () => {
  const page = await openTrade('popup.html', { width: 372, height: 640 });
  await page.getByTestId('trade-give-amount').fill('0.01');
  await page.getByTestId('trade-get-amount').fill('100');
  await page.getByTestId('trade-make-continue').click();

  const review = page.getByTestId('trade-make-review');
  await expect(review).toBeVisible();
  await expect(page.getByTestId('trade-make-review-give')).toContainText('0.01');
  await expect(page.getByTestId('trade-make-review-get')).toContainText('100');

  // Back returns to the editable form (guided steps, #169) without losing the picks.
  await page.getByTestId('trade-make-review-back').click();
  await expect(page.getByTestId('trade-make-form')).toBeVisible();
  await expect(page.getByTestId('trade-give-amount')).toHaveValue('0.01');
  await page.close();
});

test('#169: popup basic Take shows a REAL decode error for a non-decodable offer (wired to the vault, not a stub)', async () => {
  const page = await openTrade('popup.html', { width: 372, height: 640 });
  await page.getByTestId('trade-mode-take').click();
  await page.getByTestId('trade-take-input').fill('offer1-not-a-real-offer');
  await page.getByTestId('trade-take-review-btn').click();
  await expect(page.getByTestId('trade-take-error')).toBeVisible();
  await expect(page.getByTestId('trade-take-review')).toHaveCount(0);
  await page.close();
});

// Visual capture (§6.5) of the #169 popup basic surfaces, inspected for spacing/hierarchy.
test('screenshot: popup basic Make review + popup basic Take error', async () => {
  const page = await openTrade('popup.html', { width: 372, height: 640 });
  await page.getByTestId('trade-give-amount').fill('0.01');
  await page.getByTestId('trade-get-amount').fill('100');
  await page.getByTestId('trade-make-continue').click();
  await page.getByTestId('trade-make-review').waitFor();
  await page.waitForTimeout(250);
  await page.screenshot({ path: 'e2e/__screenshots__/popup-trade-make-review.png' });

  await page.getByTestId('trade-make-review-back').click();
  await page.getByTestId('trade-mode-take').click();
  await page.getByTestId('trade-take-input').fill('offer1-not-a-real-offer');
  await page.getByTestId('trade-take-review-btn').click();
  await page.getByTestId('trade-take-error').waitFor();
  await page.waitForTimeout(250);
  await page.screenshot({ path: 'e2e/__screenshots__/popup-trade-take-error.png' });
  await page.close();
});

test('screenshot: fullscreen Make review (#169 clarity redesign, full surface)', async () => {
  const page = await openTrade('app.html', { width: 1200, height: 860 });
  await page.getByTestId('trade-give-amount').fill('0.01');
  await page.getByTestId('trade-get-amount').fill('100');
  await page.getByTestId('trade-make-continue').click();
  await page.getByTestId('trade-make-review').waitFor();
  await page.waitForTimeout(250);
  await page.screenshot({ path: 'e2e/__screenshots__/fullscreen-trade-make-review.png' });
  await page.close();
});
