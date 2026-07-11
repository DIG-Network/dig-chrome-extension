import { test, expect, chromium, type BrowserContext, type Worker, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

/**
 * END-USER e2e for the extension's settings home (`options.html`), driven against the BUILT unpacked
 * extension over REAL `chrome.storage.local`. This page carries two things the contract requires a
 * user-facing surface for and that had no built-extension proof (#116):
 *   - the theme switcher (#211) — light / dark / system, persisted + applied live to the document;
 *   - the §5.3 CUSTOM dig-node config — a first-class, discoverable way to set + persist a custom
 *     node host (`server.host`, kept in sync with the legacy `server.url`/`server.port` split) and
 *     the upstream RPC endpoint (`digRpcEndpoint`), each with a restore-default affordance.
 *
 * All state round-trips through the extension's REAL storage (no stub), so these assert the true
 * persisted keys the background read path reads — the settings page and the read path can never
 * disagree on a value the user set. The dig-node reachability check runs against the real resolver
 * (nothing listening in CI) → the honest "not found, will use hosted RPC" note.
 *
 * Captures the settings screenshot (§6.5).
 *
 * Run: `npm run build && npm run test:sw`.
 */

const EXT_PATH = resolve(process.cwd(), 'dist');

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let extensionId: string;
let worker: Worker;

/** Read a key straight from the extension's real chrome.storage.local (via the SW page context). */
function readStorage<T>(page: Page, key: string): Promise<T | undefined> {
  return page.evaluate(
    (k) => new Promise<T | undefined>((res) => chrome.storage.local.get(k, (o) => res((o as Record<string, T>)[k]))),
    key,
  );
}

async function openOptions(): Promise<Page> {
  const page = await context.newPage();
  await page.setViewportSize({ width: 720, height: 900 });
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await page.getByTestId('options-root').waitFor();
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

test('theme switcher: dark applies live to the document and persists', async () => {
  const page = await openOptions();
  const select = page.getByTestId('options-theme-select');
  // #211 default is light (no OS-following `system` on a fresh install).
  await expect(select).toHaveValue('light');
  await expect(page.locator('html')).toHaveAttribute('data-dig-theme', 'light');

  await select.selectOption('dark');
  await expect(page.locator('html')).toHaveAttribute('data-dig-theme', 'dark');

  // Persisted into the shared wallet.settings blob → survives a reopen (the popup/wallet read it live).
  const reopened = await openOptions();
  await expect(reopened.getByTestId('options-theme-select')).toHaveValue('dark');
  await expect(reopened.locator('html')).toHaveAttribute('data-dig-theme', 'dark');

  await reopened.waitForTimeout(120);
  await reopened.screenshot({ path: 'e2e/__screenshots__/options-settings-dark.png' });
  await reopened.close();
  await page.close();
});

test('custom dig-node host persists (server.host + legacy split) and shows the honest not-found note', async () => {
  const page = await openOptions();
  const host = page.getByTestId('dignode-host-input');
  await host.fill('my-node.example:9999');
  await host.blur();

  // The §5.3 custom host is persisted verbatim, and the legacy split keys are kept in sync so the
  // background read path resolves the same endpoint the user typed.
  await expect.poll(() => readStorage<string>(page, 'server.host')).toBe('my-node.example:9999');
  await expect.poll(() => readStorage<string>(page, 'server.url')).toBe('my-node.example');
  await expect.poll(() => readStorage<number>(page, 'server.port')).toBe(9999);

  // Nothing is listening in CI → the honest install/fallback note (never a false "reachable").
  await expect(page.getByTestId('dignode-status')).toContainText(/not found/i);

  // The restore-default affordance resets the host to the canonical default — explicit IPv4
  // (127.0.0.1), never the bare word `localhost` (#287: Windows resolves `localhost` to `::1`
  // first, which the IPv4-only dig-node never answers on).
  await page.getByTestId('dignode-host-reset').click();
  await expect.poll(() => readStorage<string>(page, 'server.host')).toBe('127.0.0.1:9778');
  await page.close();
});

test('custom upstream RPC endpoint persists and normalizes, and resets to the default', async () => {
  const page = await openOptions();
  const rpc = page.getByTestId('rpc-endpoint-input');
  await rpc.fill('https://my-rpc.example');
  await rpc.blur();
  // A trailing slash is normalized on.
  await expect.poll(() => readStorage<string>(page, 'digRpcEndpoint')).toBe('https://my-rpc.example/');

  await page.getByTestId('rpc-endpoint-reset').click();
  await expect.poll(() => readStorage<string>(page, 'digRpcEndpoint')).toBe('https://rpc.dig.net/');
  await page.close();
});

/**
 * #212 — the settings page carries the same §6.7 build attribution as the main shell: a real
 * (non-placeholder) semver in the on-page footer + `<meta name="app-version">` + the
 * `window.__APP_VERSION__` global, and the shared `<BugReportButton>` mounted so a user filing an
 * options-page bug report gets the standard screenshot/console-capture flow.
 */
test('#212 exposes the real app version (footer + meta + window global) and mounts the bug-report widget', async () => {
  const page = await openOptions();

  const version = await page.evaluate(() => (window as unknown as { __APP_VERSION__?: string }).__APP_VERSION__);
  expect(version).toBeTruthy();
  expect(version).not.toBe('__APP_VERSION__');

  await expect(page.getByTestId('app-version')).toHaveText(`v${version}`);
  const metaContent = await page.locator('meta[name="app-version"]').getAttribute('content');
  expect(metaContent).toBe(version);

  await expect(page.getByTestId('bugreport-launcher')).toBeVisible();
  await page.close();
});
