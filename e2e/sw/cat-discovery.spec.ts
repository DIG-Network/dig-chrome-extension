import { test, expect, chromium, type BrowserContext, type Worker, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

/**
 * END-USER e2e for #87 — CAT auto-discovery + token metadata, driven against the BUILT unpacked
 * extension in a real browser through the real self-custody wallet + popup UI.
 *
 * Determinism note (mirrors window-chia-methods.spec.ts): a LIVE coinset is non-deterministic and the
 * offscreen document's wasm chain fetch cannot be locally routed, so a held CAT is supplied via the
 * SW's OWN cached-first path — a `walletCache.balances` snapshot is seeded (two held CATs), and the
 * fresh scan is pointed at a dead endpoint so it times out (§ the coinset per-request timeout) and the
 * SW serves the seeded holdings exactly as it would a real cached scan. The token-metadata REGISTRY is
 * genuinely MOCKED via Playwright routing (page fetch to `api.dexie.space`, CSP-allowed), and the icon
 * host (`icons.dexie.space`) is routed to a real image. The discovery reconstruction itself (hinted
 * lineage → TAIL) is proven exactly at the vault layer against the wasm Simulator (catDiscovery.test).
 *
 * It asserts the whole chain end-to-end: a held CAT AUTO-APPEARS in the popup with its registry
 * name/ticker/icon, and a held CAT ABSENT from the registry falls back to the short-form TAIL +
 * monogram (no broken image). Read-only throughout — nothing is ever broadcast.
 *
 * Run: `npm run build && npm run test:sw`.
 */

const EXT_PATH = resolve(process.cwd(), 'dist');
const GOLDEN = JSON.parse(readFileSync(resolve(process.cwd(), 'src/lib/keystore/derive.golden.json'), 'utf8')) as { mnemonic: string };
const PASSWORD = 'e2e-87-not-a-real-secret';

const REGISTERED = 'a1'.repeat(32); // 64-hex TAIL present in the mocked registry
const UNREGISTERED = 'e2'.repeat(32); // 64-hex TAIL absent from the registry (→ short-form fallback)
// A 1×1 transparent GIF; content-type drives decoding, so a valid image loads (no onError → monogram).
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let extensionId: string;
let worker: Worker;
let anchor: Page; // kept open so all-windows-close auto-lock doesn't drop the vault mid-suite

function swSend<T>(page: Page, message: Record<string, unknown>): Promise<T> {
  return page.evaluate((msg) => new Promise<T>((res) => chrome.runtime.sendMessage(msg, res as (r: unknown) => void)), message);
}

/** Open the popup on the Wallet tab, unlocking via the UI if it lands on the unlock screen. */
async function openWallet(): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html#wallet`);
  await page.getByTestId('custody-gate').waitFor({ timeout: 20_000 });
  if (await page.getByTestId('custody-unlock').isVisible().catch(() => false)) {
    await page.getByTestId('unlock-password').fill(PASSWORD);
    await page.getByTestId('unlock-submit').click();
  }
  await page.getByTestId('custody-wallet').waitFor({ timeout: 20_000 });
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

  // Mock the CAT metadata registry (one known token) + its icon host (page-level fetches — routable).
  await context.route('**/api.dexie.space/v1/swap/tokens*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        tokens: [{ id: REGISTERED, name: 'Test Token', code: 'TST', denom: 1000, icon: `https://icons.dexie.space/${REGISTERED}.webp` }],
      }),
    }),
  );
  await context.route('**/icons.dexie.space/**', (route) => route.fulfill({ status: 200, contentType: 'image/gif', body: PIXEL }));

  anchor = await context.newPage();
  await anchor.goto(`chrome-extension://${extensionId}/popup.html`);
  const imported = await swSend<{ lockState?: string }>(anchor, { action: 'importWallet', mnemonic: GOLDEN.mnemonic, password: PASSWORD });
  expect(imported.lockState).toBe('unlocked');

  // Seed a cached balance snapshot with two held CATs + point the chain at a dead endpoint so the
  // fresh scan times out (per-request coinset timeout) and getCustodyBalances serves these holdings.
  await anchor.evaluate(
    ({ reg, unreg }) =>
      chrome.storage.local.set({
        'wallet.settings': { chainRpcUrl: 'http://127.0.0.1:1', chainPrivacyAck: true },
        'walletCache.balances': { balances: { xch: 5_000_000_000_000, cats: { [reg]: 123450, [unreg]: 67890 } }, at: Date.now() },
      }),
    { reg: REGISTERED, unreg: UNREGISTERED },
  );
});

test.afterAll(async () => {
  await context?.close();
});

test('a held CAT auto-appears with its registry name/ticker/icon', async () => {
  const page = await openWallet();
  const row = page.getByTestId(`asset-cat-${REGISTERED}`);
  await expect(row).toBeVisible({ timeout: 25_000 });
  await expect(row).toContainText('TST'); // ticker from the registry
  await expect(row).toContainText('Test Token'); // human name from the registry
  // The registry icon loaded (a valid image → no onError → the <img> stays, not a monogram).
  await expect(page.getByTestId(`asset-cat-${REGISTERED}-icon`)).toBeVisible();
  await page.close();
});

test('a held CAT absent from the registry falls back to the short-form TAIL + monogram', async () => {
  const page = await openWallet();
  const row = page.getByTestId(`asset-cat-${UNREGISTERED}`);
  await expect(row).toBeVisible({ timeout: 25_000 });
  await expect(row).toContainText('e2e2e2'); // short-form of the raw TAIL
  // No registry entry → no icon element → the monogram badge is shown instead.
  await expect(page.getByTestId(`asset-cat-${UNREGISTERED}-icon`)).toHaveCount(0);
  await page.close();
});
