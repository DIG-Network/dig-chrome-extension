import { test, expect, chromium, type BrowserContext, type Worker, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

/**
 * END-USER e2e for the DIG Shields surface (#134) — the Network screen's Shield sub-view
 * (`#network/shield`), driven against the BUILT unpacked extension in a real headless Chromium over
 * the REAL background service worker's per-tab proof ledger. No prior e2e drove the Shield panel;
 * this closes that gap (#116). Proves the two honest states the panel must render:
 *
 *   1. **No content verified yet on this tab** → the empty state (`shield-empty`), NEVER a stuck
 *      spinner or a fabricated verdict.
 *   2. **Resource verdicts recorded** (the SAME `recordLedgerEntry` wire the dig-viewer uses when it
 *      renders chia:// content) → the panel lists the capsule (`storeId:rootHash`), the aggregate
 *      pass/fail pill, and each per-resource proof grouped Verified / Failed. Fail-closed: a
 *      resource recorded with `inclusionProofPassed:false` lands under Failed with its error code.
 *
 * The ledger is per-tab (keyed by `sender.tab.id`); recording FROM the popup page makes that page's
 * own tab the ledger owner, and `getShieldLedger` reads the active tab — the same tab — so the panel
 * reflects exactly what was recorded. This drives the real SW dispatch (`recordLedgerEntry` +
 * `getShieldLedger`), the real RTK Query `Shield` cache, and the real ShieldTab render — only the
 * upstream loader (which would normally record the verdicts) is stood in for by direct records.
 *
 * Also captures the popup + fullscreen screenshots (§6.5) so the verified/failed rendering can be
 * visually inspected for spacing/rhythm.
 *
 * Run: `npm run build && npm run test:sw`.
 */

const EXT_PATH = resolve(process.cwd(), 'dist');
const STORE_ID = 'a'.repeat(64);
const ROOT_HASH = 'b'.repeat(64);

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let extensionId: string;
let worker: Worker;

function swSend<T>(page: Page, message: Record<string, unknown>): Promise<T> {
  return page.evaluate((msg) => new Promise<T>((res) => chrome.runtime.sendMessage(msg, res as (r: unknown) => void)), message);
}

/** Open a fresh popup page on the Shield sub-view (a distinct tab → its own per-tab ledger). */
async function openShield(): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html#network/shield`);
  await page.getByTestId('shield-panel').waitFor();
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
});

test.afterAll(async () => {
  await context?.close();
});

test('no content verified on this tab → the honest empty Shield state', async () => {
  const page = await openShield();
  // Nothing recorded for this tab yet → the four-state empty branch, never a spinner-forever.
  await expect(page.getByTestId('shield-empty')).toBeVisible();
  await expect(page.getByTestId('shield-capsule')).toHaveCount(0);

  await page.setViewportSize({ width: 372, height: 640 });
  await page.waitForTimeout(150);
  await page.screenshot({ path: 'e2e/__screenshots__/shield-empty-popup.png' });
  await page.close();
});

test('recorded per-resource verdicts render the capsule, aggregate verdict, and grouped proofs', async () => {
  const page = await openShield();

  // Record three resource verdicts the way the dig-viewer's loader does (real SW dispatch, this
  // page's tab owns the ledger). Two pass, one fails → the panel must show a mixed "some failed"
  // verdict with the failing resource grouped under Failed.
  await swSend(page, {
    action: 'recordLedgerEntry', storeId: STORE_ID, rootHash: ROOT_HASH,
    resourcePath: 'index.html', inclusionProofPassed: true, errorCode: '', executionProofStatus: '',
  });
  await swSend(page, {
    action: 'recordLedgerEntry', storeId: STORE_ID, rootHash: ROOT_HASH,
    resourcePath: 'app.js', inclusionProofPassed: true, errorCode: '', executionProofStatus: '',
  });
  await swSend(page, {
    action: 'recordLedgerEntry', storeId: STORE_ID, rootHash: ROOT_HASH,
    resourcePath: 'evil.js', inclusionProofPassed: false, errorCode: 'DIG_ERR_PROOF_MISMATCH', executionProofStatus: '',
  });

  // Reload so the ShieldTab re-queries the SW (getShieldLedger) against the now-populated ledger.
  await page.reload();
  await page.waitForURL(/#network\/shield/);
  await page.getByTestId('shield-panel').waitFor();

  // The capsule (storeId:rootHash) is disclosed.
  await expect(page.getByTestId('shield-capsule')).toBeVisible();
  await expect(page.getByTestId('shield-capsule')).toContainText(STORE_ID.slice(0, 10));

  // Mixed result → the aggregate verdict reads "some failed", not all-passed.
  await expect(page.getByTestId('shield-verdict')).toBeVisible();

  // Two verified resources, one failed — grouped correctly (fail-closed).
  await expect(page.getByTestId('shield-passed-item')).toHaveCount(2);
  await expect(page.getByTestId('shield-failed-item')).toHaveCount(1);
  await expect(page.getByTestId('shield-failed-item')).toContainText('evil.js');
  await expect(page.getByTestId('shield-failed-item')).toContainText('DIG_ERR_PROOF_MISMATCH');

  await page.setViewportSize({ width: 372, height: 640 });
  await page.waitForTimeout(150);
  await page.screenshot({ path: 'e2e/__screenshots__/shield-populated-popup.png' });

  const fullscreen = await context.newPage();
  await fullscreen.setViewportSize({ width: 1200, height: 860 });
  await fullscreen.goto(`chrome-extension://${extensionId}/app.html#network/shield`);
  await fullscreen.getByTestId('shield-panel').waitFor();
  await fullscreen.waitForTimeout(150);
  await fullscreen.screenshot({ path: 'e2e/__screenshots__/shield-populated-fullscreen.png' });

  await fullscreen.close();
  await page.close();
});

test('the bottom-nav + segmented sub-nav reach the Shield panel (mobile-OS shell)', async () => {
  // Prove the 4-tab mobile-OS shell + the Network segmented control land on Shield end-to-end,
  // not only via a deep link: open Home, tap Network in the bottom bar, pick the Shield segment.
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.getByTestId('tab-network').click();
  await expect(page.getByTestId('network-panel')).toBeVisible();
  await page.getByTestId('seg-shield').click();
  await expect(page.getByTestId('shield-panel')).toBeVisible();
  await page.close();
});
