import { test, expect, chromium, type BrowserContext, type Worker, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

/**
 * END-USER e2e for #166 — back button always in a sticky top header (not the bottom of a growable
 * view) + the Receive QR/address prominence redesign — driven against the BUILT unpacked extension
 * in a real browser through the real self-custody wallet + popup/fullscreen UI.
 *
 * Two acceptance criteria (issue #166), both proven here without any live-chain dependency:
 *   1. A view whose body can grow long (Manage Tokens, with MANY hidden CATs) keeps its back/close
 *      action reachable at the TOP even after scrolling deep into the list — proven by scrolling the
 *      one scroll container (`.dig-main`) and asserting the header + back button are still pinned
 *      near the viewport top (sticky, not pushed off-screen).
 *   2. The Receive screen shows the QR + address as the FIRST thing on it — reachable with ZERO
 *      scrolling — regardless of how many CATs the wallet holds. Proven with a few-CATs AND a
 *      many-CATs snapshot (both via the SW's cached-first balances path, deterministic in CI).
 *
 * Run: `npm run build && npm run test:sw`.
 */

const EXT_PATH = resolve(process.cwd(), 'dist');
const GOLDEN = JSON.parse(readFileSync(resolve(process.cwd(), 'src/lib/keystore/derive.golden.json'), 'utf8')) as { mnemonic: string };
const PASSWORD = 'e2e-166-not-a-real-secret';

/** 20 synthetic 64-hex-char CAT tails, so a "many CATs" wallet needs no real CAT metadata. */
const MANY_CATS = Array.from({ length: 20 }, (_, i) => i.toString(16).padStart(2, '0').repeat(32));
/** 40 synthetic hidden-CAT tails — enough rows in Manage Tokens to force real scrolling. */
const MANY_HIDDEN = Array.from({ length: 40 }, (_, i) => (i + 100).toString(16).padStart(2, '0').repeat(32));

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let extensionId: string;
let worker: Worker;
let anchor: Page;

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

/** Open the popup/fullscreen on the Wallet tab, unlocking via the UI if it lands on the unlock screen. */
async function openWallet(file: 'popup.html' | 'app.html', size: { width: number; height: number }): Promise<Page> {
  const page = await context.newPage();
  await page.setViewportSize(size);
  await page.goto(`chrome-extension://${extensionId}/${file}#wallet`);
  await unlockIfNeeded(page);
  return page;
}

/** Overwrite the cached balances snapshot with the given CAT tails (each 1000 base units), then reload. */
async function reseedBalances(page: Page, cats: readonly string[]): Promise<void> {
  await page.evaluate(
    (catIds) =>
      chrome.storage.local.set({
        'walletCache.balances': {
          balances: { xch: 1_000_000_000_000, cats: Object.fromEntries((catIds as string[]).map((id) => [id, 1000])) },
          at: Date.now(),
        },
      }),
    cats,
  );
  await page.reload();
  await unlockIfNeeded(page);
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

  // Point the chain at a dead endpoint + ack privacy so the balances query falls back to the seeded
  // cache instantly instead of hanging on a live coinset read (mirrors asset-list-order-filter.spec.ts).
  await anchor.evaluate(
    ({ cats, hidden }) =>
      chrome.storage.local.set({
        'wallet.settings': { chainRpcUrl: 'http://127.0.0.1:1', chainPrivacyAck: true },
        'wallet.hiddenCats': hidden,
        'walletCache.balances': {
          balances: { xch: 1_000_000_000_000, cats: Object.fromEntries(cats.map((id: string) => [id, 1000])) },
          at: Date.now(),
        },
      }),
    { cats: MANY_CATS, hidden: MANY_HIDDEN },
  );
});

test.afterAll(async () => {
  await context?.close();
});

test('#166: the header back action stays pinned at the top while a long Manage Tokens list scrolls', async () => {
  const page = await openWallet('popup.html', { width: 372, height: 640 });
  await page.getByTestId('action-manage-tokens').click();
  await page.getByTestId('manage-tokens-close').waitFor();

  // 40 hidden rows make the body far taller than the viewport — scroll deep into it.
  await page.evaluate(() => {
    const scroller = document.querySelector('.dig-main');
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  });

  // The sticky header + its back button are still visible AND still near the top of the viewport
  // (not scrolled away with the body) — the #166 fix, proven against the real CSS in a real browser.
  const header = page.getByTestId('view-header');
  await expect(header).toBeVisible();
  const box = await header.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y).toBeLessThan(120); // pinned near the very top, not wherever it fell in the flow
  await expect(page.getByTestId('manage-tokens-close')).toBeVisible();
  await page.close();
});

for (const [label, cats] of [
  ['few-cats', []],
  ['many-cats', MANY_CATS],
] as const) {
  test(`#166: Receive shows the QR + address at the top with zero scrolling (${label})`, async () => {
    const page = await openWallet('popup.html', { width: 372, height: 640 });
    await reseedBalances(page, cats);

    // `force` skips Playwright's own scroll-into-view actionability step, so this reflects a plain
    // click on the (already-visible, near-top) action bar — not an artifact of the test driver.
    await page.getByTestId('action-receive').click({ force: true });
    const addr = page.getByTestId('wallet-address');
    await expect(addr).toBeVisible();

    // Reachable with ZERO scrolling: reset to the top of the ONE scroll container (representing a
    // fresh arrival on the Receive screen) and confirm the address sits within the viewport bounds —
    // independent of how many CATs (0 vs 20) the wallet holds, since the screen has no CAT list at all.
    await page.evaluate(() => {
      const scroller = document.querySelector('.dig-main');
      if (scroller) scroller.scrollTop = 0;
    });
    const box = await addr.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y + box!.height).toBeLessThanOrEqual(640);
    // The screen has no asset/CAT list at all — the CAT count structurally cannot push it down.
    await expect(page.getByTestId('custody-assets')).toHaveCount(0);
    await page.close();
  });
}

// Visual capture (§6.5) — the Receive screen at phone (popup) + tablet (fullscreen) widths, for both
// a few-CATs and a many-CATs wallet, inspected for spacing/hierarchy before calling #166 done.
for (const [label, file, size] of [
  ['popup', 'popup.html', { width: 372, height: 640 }],
  ['fullscreen', 'app.html', { width: 1200, height: 860 }],
] as const) {
  for (const [catsLabel, cats] of [
    ['few-cats', []],
    ['many-cats', MANY_CATS],
  ] as const) {
    test(`screenshot: Receive screen — ${label}, ${catsLabel}`, async () => {
      const page = await openWallet(file, size);
      await reseedBalances(page, cats);
      // `force` avoids Playwright's own scroll-into-view step so the capture reflects a plain click
      // on the (already-visible, near-top) action bar, not a test-driver scroll artifact.
      await page.getByTestId('action-receive').click({ force: true });
      await page.getByTestId('wallet-address').waitFor();
      await page.evaluate(() => {
        const scroller = document.querySelector('.dig-main');
        if (scroller) scroller.scrollTop = 0;
      });
      await page.waitForTimeout(300);
      await page.screenshot({ path: `e2e/__screenshots__/view-header-receive-${label}-${catsLabel}.png` });
      await page.close();
    });
  }
}
