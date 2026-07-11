import { test, expect, chromium, type BrowserContext, type Worker } from '@playwright/test';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

/**
 * Visual record for #379 — the creator-tip prompt (`TipCreatorWidget`) on the Home board, driven
 * against the BUILT unpacked extension. The widget self-hides unless a DIG resource is loaded on the
 * active tab AND auto-tip is off, so the SW seam is mocked as: unlocked wallet + a `getShieldLedger`
 * capsule (a DIG resource IS loaded). Screenshots at desktop + mobile widths for a §6.5 spacing
 * inspection; the widget's four states are unit-asserted in `TipCreatorWidget.test.tsx`.
 *
 * Run: `npm run build && npm run test:sw`.
 */

const EXT_PATH = resolve(process.cwd(), 'dist');
const SCREENSHOT_DIR = resolve(process.cwd(), 'e2e', '__screenshots__', 'tip-creator-379');

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let extensionId: string;

test.beforeAll(async () => {
  if (!existsSync(resolve(EXT_PATH, 'manifest.json'))) {
    throw new Error(`Built extension not found at ${EXT_PATH} — run \`npm run build\` before the SW harness.`);
  }
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    args: ['--headless=new', `--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`],
  });
  // Simulate an unlocked single-wallet session at the SW-message seam, with a DIG resource loaded on
  // the active tab (a non-null Shield-ledger capsule) so the tip prompt surfaces.
  await context.addInitScript(() => {
    const CAP = { storeId: 'a'.repeat(64), rootHash: 'b'.repeat(64) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (chrome.runtime as any).sendMessage = (message: unknown, callback?: (r: unknown) => void) => {
      const m = message as { action?: string };
      let reply: unknown = { success: true };
      switch (m?.action) {
        case 'getLockState':
          reply = { lockState: 'unlocked', activeWalletId: 'e2e-379', activeIndex: 0 };
          break;
        case 'getCustodyBalances':
          reply = { balances: { xch: 1_000_000_000_000, cats: {} } };
          break;
        case 'getActivity':
          reply = { events: [] };
          break;
        case 'listNfts':
          reply = { nfts: [] };
          break;
        case 'listClawbacks':
          reply = { clawbacks: [] };
          break;
        case 'getShieldLedger':
          reply = { capsule: CAP, verification: { state: 'verified' }, group: {}, entries: [] };
          break;
        case 'getChainSourceStatus':
          reply = { mode: 'auto', source: 'coinset', reachable: false };
          break;
        default:
          reply = { success: true };
      }
      if (callback) {
        callback(reply);
        return undefined;
      }
      return Promise.resolve(reply);
    };
  });
  const worker: Worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extensionId = worker.url().split('/')[2];
});

test.afterAll(async () => {
  await context?.close();
});

for (const [label, width, height] of [
  ['desktop', 1280, 800],
  ['mobile', 390, 780],
] as const) {
  test(`visual record: Home creator-tip prompt (${label})`, async () => {
    const page = await context.newPage();
    await page.setViewportSize({ width, height });
    await page.goto(`chrome-extension://${extensionId}/app.html`);
    const widget = page.getByTestId('tip-creator-widget');
    await widget.waitFor({ state: 'visible', timeout: 15000 });
    // The one-tap Tip + amount + set-up-auto-tip + dismiss controls are all present.
    await expect(page.getByTestId('tip-creator-send')).toBeVisible();
    await expect(page.getByTestId('tip-creator-amount')).toBeVisible();
    await page.screenshot({ path: `${SCREENSHOT_DIR}/home-tip-${label}.png` });
    await page.close();
  });
}
