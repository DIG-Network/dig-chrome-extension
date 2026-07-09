import { test, expect, chromium, type BrowserContext, type Worker, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

/**
 * END-USER e2e for #164 (Apps tab: drag-to-reorder + hide/show apps, persisted personalization) —
 * the standing acceptance bar: drive the BUILT unpacked extension in a real headless Chromium over
 * the real popup surface + `chrome.storage.local`, proving:
 *   - a keyboard reorder move persists across a popup close/reopen (a real drag isn't exercised here
 *     — native HTML5 drag-and-drop requires OS-level pointer events Playwright can't synthesize
 *     reliably in headless Chromium; the identical `reorder()`/`moveApp()` code path IS covered, and
 *     the drag SOURCE/TARGET wiring itself is proven at the unit level, `AppsTab.test.tsx`'s
 *     `fireEvent.dragStart/dragOver/drop` case);
 *   - hide removes a tile from the main grid; "Show hidden (N)" reveals it; Unhide restores it to
 *     the grid — all against the real popup, not a mock.
 *
 * No chain / no wallet / no vault: the Apps tab reads `chrome.storage.local` only, no signing.
 * `explore.dig.net/store.json` is routed to a canned two-app catalog so the test is deterministic
 * and network-independent (mirrors `screenshots.spec.ts`'s `**\/store.json` route stub).
 *
 * Run: `npm run build && npm run test:sw`.
 */

const EXT_PATH = resolve(process.cwd(), 'dist');

const CATALOG = {
  generatedAt: '2026-07-05T00:00:00Z',
  version: '0.5.0',
  apps: [
    { slug: 'chia-offer', name: 'Chia-Offer', icon: 'https://explore.dig.net/catalog/chia-offer/icon-512.png', link: 'https://chia-offer.on.dig.net/', category: 'tools', featured: true, accentColor: '#3aaa35' },
    { slug: 'hashtunes', name: 'HashTunes', icon: 'https://explore.dig.net/catalog/hashtunes/icon-512.png', link: 'https://hashtunes.on.dig.net/', category: 'tools', featured: false, accentColor: '#fb81ed' },
  ],
};

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let extensionId: string;
let worker: Worker;

/** Open a fresh popup page (simulates "open the popup" / "reopen after close") on the Apps tab. */
async function openAppsTab(): Promise<Page> {
  const page = await context.newPage();
  await page.route('**/store.json', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(CATALOG) }));
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.getByTestId('tab-apps').click();
  await page.getByTestId('apps-launcher').waitFor();
  return page;
}

test.beforeAll(async () => {
  if (!existsSync(resolve(EXT_PATH, 'manifest.json'))) {
    throw new Error(`Built extension not found at ${EXT_PATH} — run \`npm run build\` before the e2e.`);
  }
  // Route at the context level so it also covers pages opened later (the "reopen" step below).
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    args: ['--headless=new', `--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`],
  });
  await context.route('**/store.json', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(CATALOG) }));
  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extensionId = worker.url().split('/')[2];
});

test.afterAll(async () => {
  await context?.close();
});

test('keyboard-reorders a tile in edit mode and the order survives a popup close/reopen', async () => {
  const page = await openAppsTab();
  await page.getByTestId('apps-edit-toggle').click();

  const tileOrder = () => page.locator('[data-testid^="app-tile-"]:not([data-testid^="app-tile-wrap-"])').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
  await expect.poll(tileOrder).toEqual(['app-tile-chia-offer', 'app-tile-hashtunes']);

  // Move HashTunes (2nd) up one slot, ahead of Chia-Offer.
  await page.getByTestId('app-move-up-hashtunes').click();
  await expect.poll(tileOrder).toEqual(['app-tile-hashtunes', 'app-tile-chia-offer']);
  await expect(page.getByTestId('apps-announce')).toContainText('HashTunes');

  await page.screenshot({ path: 'e2e/__screenshots__/sw-apps-edit-mode.png' });
  await page.close();

  // A fresh popup (simulated reopen) reads the SAME persisted `chrome.storage.local` state.
  const reopened = await openAppsTab();
  await expect.poll(() =>
    reopened.locator('[data-testid^="app-tile-"]:not([data-testid^="app-tile-wrap-"])').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid'))),
  ).toEqual(['app-tile-hashtunes', 'app-tile-chia-offer']);
  await reopened.close();
});

test('hides an app from the grid and restores it via "show hidden" → unhide', async () => {
  const page = await openAppsTab();
  await page.getByTestId('apps-edit-toggle').click();

  await page.getByTestId('app-hide-hashtunes').click();
  await expect(page.getByTestId('app-tile-hashtunes')).toHaveCount(0);
  await expect(page.getByTestId('app-tile-chia-offer')).toBeVisible();

  const hiddenToggle = page.getByTestId('apps-hidden-toggle');
  await expect(hiddenToggle).toContainText('1');
  await hiddenToggle.click();
  await expect(page.getByTestId('hidden-app-hashtunes')).toBeVisible();
  await page.screenshot({ path: 'e2e/__screenshots__/sw-apps-hidden-panel.png' });

  await page.getByTestId('app-unhide-hashtunes').click();
  await expect(page.getByTestId('hidden-app-hashtunes')).toHaveCount(0);
  await expect(page.getByTestId('app-tile-hashtunes')).toBeVisible();

  await page.close();
});

test('renders correctly in edit mode on the fullscreen (tablet-width) surface too', async () => {
  const page = await context.newPage();
  await page.route('**/store.json', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(CATALOG) }));
  await page.setViewportSize({ width: 1200, height: 860 });
  await page.goto(`chrome-extension://${extensionId}/app.html`);
  // The desktop workspace (#85) nav lives in the sidebar (`nav-apps`), not a bottom tab bar.
  await page.getByTestId('nav-apps').click();
  await page.getByTestId('apps-launcher').waitFor();

  await page.getByTestId('apps-edit-toggle').click();
  await expect(page.getByTestId('app-move-up-hashtunes')).toBeVisible();
  await page.screenshot({ path: 'e2e/__screenshots__/sw-apps-edit-mode-fullscreen.png' });

  await page.close();
});
