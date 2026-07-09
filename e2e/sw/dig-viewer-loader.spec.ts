import { test, expect, chromium, type BrowserContext, type Worker, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

/**
 * END-USER e2e for the in-window DIG content view + BRANDED LOADER (`dig-viewer.html`, #157),
 * driven against the BUILT unpacked extension in a real browser. `open-by-urn.spec.ts` proves the
 * REDIRECT into this page; this file proves the page ITSELF — the branded loader shell and the
 * branded, non-leaking error surface it renders when a read can't proceed:
 *
 *   1. **No URN** (`dig-viewer.html` with no `?urn=`) → the branded error card, never a blank page.
 *   2. **A malformed URN** (`?urn=not-a-valid-address`) → the branded error card with the stable,
 *      machine-readable `data-dig-error=DIG_ERR_INVALID_URN` discriminant on the document, plus the
 *      friendly (never raw) human copy, the recovery actions (Try again + Go to DIG Home), and the
 *      offending address echoed back.
 *
 * These are the surfaces that render SYNCHRONOUSLY with no node/network dependency, so they are
 * deterministic in CI. The verified-content success path (spinner → decrypted iframe → "Verified on
 * Chia" banner) needs a live dig-node + the dig-client wasm decrypt and is exercised by the
 * cross-repo content-read integration, not this extension-only lane. Before any read resolves the
 * loader shows its branded loading indicator — asserted here as the initial state of the shell.
 *
 * Captures the branded-error screenshot (§6.5) so the #157 loader surface can be visually inspected.
 *
 * Run: `npm run build && npm run test:sw`.
 */

const EXT_PATH = resolve(process.cwd(), 'dist');

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let extensionId: string;
let worker: Worker;

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

test('the loader shell exposes the branded loading indicator + verify banner scaffold', async () => {
  const page = await context.newPage();
  // A syntactically valid, well-formed URN so init() gets past parse and builds the sandboxed
  // frame: the branded shell (spinner + "Loading DIG content…") and the verify-banner scaffold are
  // present. (The frame then reads through the node ladder; that async result is not asserted here.)
  await page.goto(`chrome-extension://${extensionId}/dig-viewer.html?urn=chia://${'c'.repeat(64)}/index.html`);
  await expect(page.getByTestId('verify-banner')).toBeAttached();
  await expect(page.locator('#loading')).toBeAttached();
  await expect(page.locator('#loadingText')).toContainText(/loading dig content/i);
  await page.close();
});

test('no URN → the branded error card (never a blank page)', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/dig-viewer.html`);
  const mount = page.getByTestId('error-mount');
  await expect(mount.getByRole('heading', { level: 1 })).toContainText(/couldn.t be loaded/i);
  // The recovery actions are always offered.
  await expect(mount.getByRole('button', { name: /try again/i })).toBeVisible();
  await expect(mount.getByRole('link', { name: /dig home/i })).toHaveAttribute('href', /dig\.net/);
  // The loading indicator is hidden once the error renders.
  await expect(page.locator('#loading')).toBeHidden();
  await page.close();
});

test('a malformed URN → branded error with the machine-readable DIG_ERR_INVALID_URN discriminant', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/dig-viewer.html?urn=${encodeURIComponent('not-a-valid-address')}`);

  // The stable machine discriminant is on the document + the mount — an agent branches on this
  // without scraping the (deliberately friendly) human copy.
  await expect(page.locator('html')).toHaveAttribute('data-dig-error', 'DIG_ERR_INVALID_URN');
  const mount = page.getByTestId('error-mount');
  await expect(mount).toHaveAttribute('data-dig-error', 'DIG_ERR_INVALID_URN');
  await expect(mount.getByRole('heading', { level: 1 })).toContainText(/couldn.t be loaded/i);
  // The offending address is echoed back to the user.
  await expect(mount).toContainText('not-a-valid-address');
  // Friendly copy only — never the internal parser message.
  await expect(mount).not.toContainText(/parseURN|invalid|decoy|wrong key/i);

  await page.setViewportSize({ width: 900, height: 700 });
  await page.waitForTimeout(120);
  await page.screenshot({ path: 'e2e/__screenshots__/dig-viewer-branded-error.png' });
  await page.close();
});
