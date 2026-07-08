import { test, expect, chromium, type BrowserContext, type Worker, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

/**
 * END-USER e2e for #113 (transaction detail view) + #114 (block-explorer link coverage), driven
 * against the BUILT unpacked extension in a real browser through the real self-custody wallet +
 * popup/fullscreen UI.
 *
 * A seeded `wallet.activityLog` entry (same established pattern as `activity-log.spec.ts` /
 * `cat-discovery.spec.ts` — seeding is the deterministic way to get a specific entry shape without
 * a real mainnet broadcast, §7) is expanded via the real Activity row click, and the resulting
 * detail receipt is asserted for:
 *   - #113: amount+asset, counterparty, status, timestamp, recorded fee/memo (only when present —
 *     never fabricated for an entry that didn't record one).
 *   - #114: a SpaceScan coin/transaction link, a SpaceScan ADDRESS link for the counterparty, and —
 *     for a CAT-class asset only — a SpaceScan TOKEN link.
 *
 * Run: `npm run build && npm run test:sw`.
 */

const EXT_PATH = resolve(process.cwd(), 'dist');
const GOLDEN = JSON.parse(readFileSync(resolve(process.cwd(), 'src/lib/keystore/derive.golden.json'), 'utf8')) as { mnemonic: string };
const PASSWORD = 'e2e-113-114-not-a-real-secret';

const CAT_TAIL = 'd4'.repeat(32);
const XCH_COUNTERPARTY = 'xch1qqqqe2e113qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqzzzz';

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let extensionId: string;
let worker: Worker;
let anchor: Page;

function swSend<T>(page: Page, message: Record<string, unknown>): Promise<T> {
  return page.evaluate((msg) => new Promise<T>((res) => chrome.runtime.sendMessage(msg, res as (r: unknown) => void)), message);
}

/** Open the popup/fullscreen on the Activity tab, unlocking via the UI if needed. */
async function openActivity(file: 'popup.html' | 'app.html' = 'popup.html', size?: { width: number; height: number }): Promise<Page> {
  const page = await context.newPage();
  if (size) await page.setViewportSize(size);
  await page.goto(`chrome-extension://${extensionId}/${file}#wallet`);
  await page.getByTestId('custody-gate').waitFor({ timeout: 20_000 });
  if (await page.getByTestId('custody-unlock').isVisible().catch(() => false)) {
    await page.getByTestId('unlock-password').fill(PASSWORD);
    await page.getByTestId('unlock-submit').click();
  }
  await page.getByTestId('custody-wallet').waitFor({ timeout: 20_000 });
  await page.getByTestId('seg-activity').click();
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

  const listA = await swSend<{ wallets: { id: string; active: boolean }[] }>(anchor, { action: 'listWallets' });
  const walletId = listA.wallets.find((w) => w.active)!.id;

  await anchor.evaluate(
    ({ scopeKey, catTail, counterparty }) =>
      chrome.storage.local.set({
        'wallet.activityLog': {
          [scopeKey]: [
            // A plain XCH send WITH a recorded fee + memo (#113) and a counterparty (#114 address link).
            {
              id: 'sent:e2e-113-xch',
              kind: 'sent',
              asset: 'XCH',
              amount: '250000000000',
              counterparty,
              coinId: 'ab'.repeat(32),
              timestamp: Date.now(),
              status: 'confirmed',
              fee: '5000000',
              memo: 'e2e detail-view memo',
            },
            // A CAT send with NO fee/memo recorded (#113: never fabricate) + a CAT token link (#114).
            {
              id: 'sent:e2e-114-cat',
              kind: 'sent',
              asset: catTail,
              amount: '2500',
              counterparty,
              coinId: 'cd'.repeat(32),
              timestamp: Date.now(),
              status: 'confirmed',
            },
          ],
        },
      }),
    { scopeKey: `${walletId}:0`, catTail: CAT_TAIL, counterparty: XCH_COUNTERPARTY },
  );
});

test.afterAll(async () => {
  await context?.close();
});

test('#113: expanding an XCH send shows amount, timestamp, and its recorded fee + memo', async () => {
  const page = await openActivity();
  await page.getByTestId('activity-line-sent:e2e-113-xch').click();

  await expect(page.getByTestId('activity-amount-sent:e2e-113-xch')).toContainText('0.25');
  await expect(page.getByTestId('activity-timestamp-sent:e2e-113-xch')).toBeVisible();
  await expect(page.getByTestId('activity-fee-sent:e2e-113-xch')).toContainText('0.000005');
  await expect(page.getByTestId('activity-memo-sent:e2e-113-xch')).toContainText('e2e detail-view memo');
  await page.close();
});

test('#114: the XCH receipt links the coin AND the counterparty address on SpaceScan', async () => {
  const page = await openActivity();
  await page.getByTestId('activity-line-sent:e2e-113-xch').click();

  const coinLink = page.getByTestId('activity-spacescan-sent:e2e-113-xch');
  await expect(coinLink).toHaveAttribute('href', /spacescan\.io\/coin\/0x/);
  const addressLink = page.getByTestId('activity-address-link-sent:e2e-113-xch');
  await expect(addressLink).toHaveAttribute('href', `https://www.spacescan.io/address/${XCH_COUNTERPARTY}`);
  // XCH has no CAT token page.
  await expect(page.getByTestId('activity-token-link-sent:e2e-113-xch')).toHaveCount(0);
  await page.close();
});

test('#113: a CAT entry with no recorded fee/memo shows neither (never fabricated)', async () => {
  const page = await openActivity();
  await page.getByTestId('activity-line-sent:e2e-114-cat').click();

  await expect(page.getByTestId('activity-fee-sent:e2e-114-cat')).toHaveCount(0);
  await expect(page.getByTestId('activity-memo-sent:e2e-114-cat')).toHaveCount(0);
  await page.close();
});

test('#114: a CAT entry\'s receipt links its own SpaceScan token page', async () => {
  const page = await openActivity();
  await page.getByTestId('activity-line-sent:e2e-114-cat').click();

  const tokenLink = page.getByTestId('activity-token-link-sent:e2e-114-cat');
  await expect(tokenLink).toHaveAttribute('href', `https://www.spacescan.io/token/${CAT_TAIL}`);
  await page.close();
});

// Visual capture (§6.5) — the expanded transaction-detail receipt at phone (popup) + tablet
// (fullscreen) widths, inspected for spacing before calling #113/#114 done.
for (const [label, file, size] of [
  ['popup', 'popup.html', { width: 372, height: 640 }],
  ['fullscreen', 'app.html', { width: 1200, height: 860 }],
] as const) {
  test(`screenshot: transaction detail receipt (${label})`, async () => {
    const page = await openActivity(file, size);
    await page.getByTestId('activity-line-sent:e2e-113-xch').click();
    await page.getByTestId('activity-receipt-sent:e2e-113-xch').waitFor();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `e2e/__screenshots__/activity-detail-${label}.png` });
    await page.close();
  });
}
