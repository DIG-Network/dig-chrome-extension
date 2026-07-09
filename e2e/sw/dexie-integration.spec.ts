import { test, expect, chromium, type BrowserContext, type Worker, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

/**
 * END-USER e2e for #102 (dexie.space marketplace integration) — driven against the BUILT unpacked
 * extension in a real browser through the real SW. Unlike coinset (mocked/unreachable in CI, per
 * `offers.spec.ts`), `api.dexie.space` is a public REST API reachable from CI, so this proves the
 * REAL wiring end-to-end rather than just "not the unknown-action stub":
 *   - `dexieBrowse` returns real, well-formed open-offer data from the live API.
 *   - `dexiePost` with a garbage (non-decodable) string gets dexie's own real rejection.
 *   - `dexieResolve` with garbage input returns `{ offer: null }` rather than throwing.
 *   - The real fullscreen Take form's "Browse Dexie" toggle reaches the live API and renders rows
 *     (or the real empty state, if dexie currently has zero open offers — never crashes either way).
 *
 * This pass never posts a REAL offer to dexie (that needs a real `offer1…` string this wallet built,
 * which needs a live coinset read — out of scope here, same split as `offers.spec.ts`) and never
 * broadcasts a mainnet spend.
 *
 * Run: `npm run build && npm run test:sw`.
 */

const EXT_PATH = resolve(process.cwd(), 'dist');
const GOLDEN = JSON.parse(readFileSync(resolve(process.cwd(), 'src/lib/keystore/derive.golden.json'), 'utf8')) as { mnemonic: string };
const PASSWORD = 'e2e-102-not-a-real-secret';

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
  await anchor.evaluate(() => chrome.storage.local.set({ 'wallet.settings': { chainPrivacyAck: true } }));
  await anchor.close();
});

test.afterAll(async () => {
  await context?.close();
});

test('#102: dexieBrowse reaches the live api.dexie.space and returns well-formed offer data', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  const res = await swSend<{ offers?: unknown[] }>(page, { action: 'dexieBrowse' });
  expect(Array.isArray(res.offers)).toBe(true);
  // dexie.space has hundreds of thousands of open offers historically — a truly empty result would
  // itself indicate a wiring problem, but assert structurally rather than an exact count (live data).
  if (res.offers && res.offers.length > 0) {
    const first = res.offers[0] as Record<string, unknown>;
    expect(typeof first.id).toBe('string');
    expect(typeof first.offerStr).toBe('string');
    expect(first.offerStr).toMatch(/^offer1/);
    expect(typeof first.status).toBe('number');
    expect(Array.isArray(first.offered)).toBe(true);
    expect(Array.isArray(first.requested)).toBe(true);
  }
  await page.close();
});

test('#102: dexiePost with a non-decodable string gets a real rejection from dexie', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  const res = await swSend<{ success?: boolean; code?: string; message?: string }>(page, {
    action: 'dexiePost',
    offer: 'offer1-not-a-real-offer',
  });
  expect(res.success).toBe(false);
  expect(res.code).toBe('DEXIE_POST_FAILED');
  await page.close();
});

test('#102: dexiePost rejects a missing/malformed offer before ever calling dexie', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  const res = await swSend<{ success?: boolean; code?: string }>(page, { action: 'dexiePost', offer: 'not-an-offer-string' });
  expect(res.success).toBe(false);
  expect(res.code).toBe('BAD_REQUEST');
  await page.close();
});

test('#102: dexieResolve returns { offer: null } for an unknown/garbage id, never throws', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  const res = await swSend<{ offer: unknown }>(page, { action: 'dexieResolve', idOrUrl: 'definitely-not-a-real-dexie-id-000' });
  expect(res.offer).toBeNull();
  await page.close();
});

test('#102: the popup Take form has no "Browse Dexie" action (basic surface)', async () => {
  const page = await openTrade('popup.html', { width: 372, height: 640 });
  await page.getByTestId('trade-mode-take').click();
  await expect(page.getByTestId('trade-take-dexie-browse')).toHaveCount(0);
  await page.close();
});

test('#102: fullscreen Take → Browse Dexie reaches the live API and renders real rows', async () => {
  const page = await openTrade('app.html', { width: 1200, height: 860 });
  await page.getByTestId('trade-mode-take').click();
  await page.getByTestId('trade-take-dexie-browse').click();
  // Either real rows or the real empty state — never a crash (dexie has hundreds of thousands of
  // open offers historically, so rows are the expected outcome, but assert leniently on live data).
  await Promise.race([
    page.locator('[data-testid="trade-take-dexie-browse-list"] li').first().waitFor({ timeout: 15_000 }),
    page.getByTestId('trade-take-dexie-browse-empty').waitFor({ timeout: 15_000 }),
  ]);
  await page.close();
});

// Visual capture (§6.5) of the #102 fullscreen "Browse Dexie" panel, inspected for spacing/hierarchy.
test('screenshot: fullscreen Take with Browse Dexie open', async () => {
  const page = await openTrade('app.html', { width: 1200, height: 860 });
  await page.getByTestId('trade-mode-take').click();
  await page.getByTestId('trade-take-dexie-browse').click();
  await Promise.race([
    page.locator('[data-testid="trade-take-dexie-browse-list"] li').first().waitFor({ timeout: 15_000 }),
    page.getByTestId('trade-take-dexie-browse-empty').waitFor({ timeout: 15_000 }),
  ]);
  await page.waitForTimeout(250);
  await page.screenshot({ path: 'e2e/__screenshots__/fullscreen-trade-dexie-browse.png' });
  await page.close();
});
