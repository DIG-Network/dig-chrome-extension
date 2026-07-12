import { test, expect, chromium, type BrowserContext, type Worker, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

/**
 * END-USER e2e for #484 — the swap container's amount-to-swap input, driven against the BUILT
 * unpacked extension in a real browser through the real self-custody wallet + fullscreen Trade→Swap
 * UI (real clicks, not raw `chrome.runtime.sendMessage` calls). Mirrors the cache-seeding technique
 * in trade-basic-surfaces.spec.ts (`wallet.settings` pointed at a dead RPC + `chainPrivacyAck`, plus
 * a seeded `walletCache.balances`) so the wallet has a real, deterministic XCH balance with no live
 * coinset dependency, and `dexie-integration.spec.ts`'s route-mocking of `api.dexie.space` so the
 * quote numbers this spec asserts on are fully controlled (not live order-book data).
 *
 * Swap is XCH → $DIG (both built-in assets — no CAT registry/watched-CAT setup needed). Two open
 * offers are seeded: "rich" (best rate, needs 15 XCH) and "affordable" (worse rate, needs only 2
 * XCH). This proves the amount field:
 *   1. gates the review/submit button (invalid amount disables it, with an inline error);
 *   2. steers WHICH offer gets matched — typing "2" excludes the unaffordable "rich" offer and
 *      selects "affordable" instead, even though "rich" is the better rate.
 *
 * Never broadcasts a mainnet spend (stops at the amount/quote layer — `prepareTrade`/`confirmTrade`
 * money-path correctness is proven by `swapPanel.test.tsx` against a mocked SW and, at the engine
 * layer, by the existing offer/take suites).
 *
 * Run: `npm run build && npm run test:sw`.
 */

const EXT_PATH = resolve(process.cwd(), 'dist');
const GOLDEN = JSON.parse(readFileSync(resolve(process.cwd(), 'src/lib/keystore/derive.golden.json'), 'utf8')) as { mnemonic: string };
const PASSWORD = 'e2e-484-not-a-real-secret';
const DIG_ASSET_ID = 'a406d3a9de984d03c9591c10d917593b434d5263cabe2b42f6b367df16832f81';

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let extensionId: string;
let worker: Worker;

function swSend<T>(page: Page, message: Record<string, unknown>): Promise<T> {
  return page.evaluate((msg) => new Promise<T>((res) => chrome.runtime.sendMessage(msg, res as (r: unknown) => void)), message);
}

function json(body: unknown) {
  return { status: 200, contentType: 'application/json', body: JSON.stringify(body) };
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

/** Open the fullscreen app directly on the Trade→Swap sub-view (Swap is fullscreen-only, §6.4). */
async function openSwap(size: { width: number; height: number }): Promise<Page> {
  const page = await context.newPage();
  await page.setViewportSize(size);
  await page.goto(`chrome-extension://${extensionId}/app.html#wallet/trade`);
  await unlockIfNeeded(page);
  await page.getByTestId('custody-trade').waitFor();
  await page.getByTestId('trade-mode-swap').click();
  await page.getByTestId('swap-panel').waitFor();
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

  // Two controlled open offers on the XCH/$DIG pair: "rich" is the best rate (100 $DIG/XCH) but
  // needs 15 XCH; "affordable" is a worse rate (75 $DIG/XCH) but only needs 2 XCH.
  await context.route('**/api.dexie.space/v1/offers*', (route) =>
    route.fulfill(
      json({
        success: true,
        count: 2,
        page: 1,
        page_size: 20,
        offers: [
          {
            id: 'rich',
            offer: 'offer1rich',
            status: 0,
            date_found: '2026-01-01T00:00:00Z',
            offered: [{ id: DIG_ASSET_ID, code: 'DIG', name: 'DIG', amount: 1500 }],
            requested: [{ id: 'xch', code: 'XCH', name: 'Chia', amount: 15 }],
          },
          {
            id: 'affordable',
            offer: 'offer1affordable',
            status: 0,
            date_found: '2026-01-01T00:00:00Z',
            offered: [{ id: DIG_ASSET_ID, code: 'DIG', name: 'DIG', amount: 150 }],
            requested: [{ id: 'xch', code: 'XCH', name: 'Chia', amount: 2 }],
          },
        ],
      }),
    ),
  );

  const anchor = await context.newPage();
  await anchor.goto(`chrome-extension://${extensionId}/popup.html`);
  const imported = await swSend<{ lockState?: string }>(anchor, { action: 'importWallet', mnemonic: GOLDEN.mnemonic, password: PASSWORD });
  expect(imported.lockState).toBe('unlocked');

  // Point the chain at a dead endpoint + ack privacy (mirrors trade-basic-surfaces.spec.ts) so the
  // balances query resolves from this SEEDED cache instantly instead of hanging on an unreachable
  // live coinset read in CI — a real 20 XCH balance the amount-validation checks run against.
  await anchor.evaluate(
    ({ digId }) =>
      chrome.storage.local.set({
        'wallet.settings': { chainRpcUrl: 'http://127.0.0.1:1', chainPrivacyAck: true },
        'walletCache.balances': { balances: { xch: 20_000_000_000_000, cats: { [digId]: 500_000 } }, at: Date.now() },
      }),
    { digId: DIG_ASSET_ID },
  );
  await anchor.close();
});

test.afterAll(async () => {
  await context?.close();
});

test('#484: shows the balance + the unconstrained best-rate quote before any amount is typed', async () => {
  const page = await openSwap({ width: 1200, height: 860 });
  await expect(page.getByTestId('swap-amount-balance')).toContainText('20');
  await expect(page.getByTestId('swap-amount-balance')).toContainText('XCH');
  await expect(page.getByTestId('swap-quote-result')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('swap-quote-pay')).toContainText('15 XCH'); // "rich" — best rate
  await expect(page.getByTestId('swap-review')).toBeDisabled(); // no amount entered yet
  await page.close();
});

test('#484: an invalid amount (zero) shows an inline error and blocks submit', async () => {
  const page = await openSwap({ width: 1200, height: 860 });
  await page.getByTestId('swap-quote-result').waitFor({ timeout: 15_000 });
  await page.getByTestId('swap-amount').fill('0');
  await expect(page.getByTestId('swap-amount-error')).toBeVisible();
  await expect(page.getByTestId('swap-review')).toBeDisabled();
  await page.close();
});

test('#484: an amount over the wallet balance shows an inline error and blocks submit', async () => {
  const page = await openSwap({ width: 1200, height: 860 });
  await page.getByTestId('swap-quote-result').waitFor({ timeout: 15_000 });
  await page.getByTestId('swap-amount').fill('25'); // wallet holds only 20 XCH
  await expect(page.getByTestId('swap-amount-error')).toBeVisible();
  await expect(page.getByTestId('swap-review')).toBeDisabled();
  await page.close();
});

test('#484: entering an affordable amount reselects the offer that FITS it (not the global best rate) and enables submit', async () => {
  const page = await openSwap({ width: 1200, height: 860 });
  await page.getByTestId('swap-quote-result').waitFor({ timeout: 15_000 });
  await expect(page.getByTestId('swap-quote-pay')).toContainText('15 XCH'); // default: "rich"

  await page.getByTestId('swap-amount').fill('2');
  await expect(page.getByTestId('swap-quote-pay')).toContainText('2 XCH'); // now: "affordable"
  await expect(page.getByTestId('swap-quote-receive')).toContainText('150 DIG');
  await expect(page.getByTestId('swap-review')).toBeEnabled();
  await page.close();
});

test('#484: the Max button fills the full spendable XCH balance', async () => {
  const page = await openSwap({ width: 1200, height: 860 });
  await page.getByTestId('swap-quote-result').waitFor({ timeout: 15_000 });
  await page.getByTestId('swap-amount-max').click();
  await expect(page.getByTestId('swap-amount')).toHaveValue('20');
  await expect(page.getByTestId('swap-review')).toBeEnabled();
  await page.close();
});

// Visual capture (§6.5) — the amount field + a live quote + an inline validation error, desktop +
// mobile widths, for a spacing/hierarchy inspection.
for (const [label, size] of [
  ['desktop', { width: 1200, height: 860 }],
  ['mobile', { width: 390, height: 780 }],
] as const) {
  test(`screenshot: swap amount input with a live quote (${label})`, async () => {
    const page = await openSwap(size);
    await page.getByTestId('swap-quote-result').waitFor({ timeout: 15_000 });
    await page.getByTestId('swap-amount').fill('2');
    await page.getByTestId('swap-quote-pay').getByText('2 XCH').waitFor().catch(() => {});
    await page.waitForTimeout(250);
    await page.screenshot({ path: `e2e/__screenshots__/swap-amount-${label}.png`, fullPage: true });
    await page.close();
  });

  test(`screenshot: swap amount validation error (${label})`, async () => {
    const page = await openSwap(size);
    await page.getByTestId('swap-quote-result').waitFor({ timeout: 15_000 });
    await page.getByTestId('swap-amount').fill('25');
    await page.getByTestId('swap-amount-error').waitFor();
    await page.waitForTimeout(250);
    await page.screenshot({ path: `e2e/__screenshots__/swap-amount-error-${label}.png`, fullPage: true });
    await page.close();
  });
}
