import { test, expect, chromium, type BrowserContext, type Worker, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * #289 / #291 / #292 — the built extension, in real (headless) Chromium, proves the node-serve
 * navigation + injected toolbar batch END-TO-END against a FIXTURE dig-node (a local HTTP server
 * that answers the §5.3 reachability probe AND serves `/s/<store>[:root]/<path>` with the DIG
 * Shields `X-Dig-*` headers — standing in for a live node, which CI has none of):
 *
 *   #289 · with a local node reachable, a chia:// navigation lands the TAB DIRECTLY on the node's
 *          plaintext serve URL (`http://<node>/s/<store>/<path>`) — the real website, not the
 *          sandbox viewer. With NO local node, it keeps the sandbox dig-viewer + rpc path.
 *   #292 · the toggle-gated toolbar injects atop an ordinary page (shadow-DOM isolated), its icons
 *          open the full-page surfaces, and its badges light up from the node's `X-Dig-*` headers
 *          on a node-served page; toggling off removes it.
 *   #291 · the omnibox keyword is wired (`dig`), and its Enter path is the SAME node-or-sandbox
 *          navigation asserted in #289 (the real omnibox keystroke path is not Playwright-scriptable;
 *          the resolve/suggest logic is unit-tested in src/lib/apps.test.ts).
 *
 * The fixture binds 127.0.0.5 (a NON-alias loopback, the harness's proven literal) so `server.host`
 * is treated as a GENUINE §5.3 custom override that wins the ladder entirely and points the
 * extension at the fixture. Requires only a built dist/ — no live node, no mainnet.
 */

const EXT_PATH = resolve(process.cwd(), 'dist');
const FIXTURE_HOST = '127.0.0.5';
const STORE = 'ab554db9c62e8dc2185914741e06539bacdcc3670762417a5f644b84fd382812';
const ROOT = '9e26ff2500930604278dd013c986a3d3ace2565c69e13583e8575c70319bd98b';
const MARKER = 'NODE-SERVED PLAINTEXT OK';
const CHIA_URL = `chia://urn:dig:chia:${STORE}/index.html`;

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let extensionId: string;
let worker: Worker;
let server: Server;
let nodeBase: string;

/** A fixture dig-node: answers the §5.3 probe at `/` and serves `/s/<store>[:root]/<path>` (GET +
 *  HEAD) with the DIG Shields headers a real local node sets (#289 serve contract). */
function startFixture(): Promise<void> {
  return new Promise((res, rej) => {
    server = createServer((req: IncomingMessage, cres: ServerResponse) => {
      const url = req.url || '/';
      if (url.startsWith('/s/')) {
        const headers: Record<string, string> = {
          'content-type': 'text/html; charset=utf-8',
          'x-dig-verified': 'true',
          'x-dig-root': ROOT,
          'x-dig-source': 'local',
          'access-control-allow-origin': '*',
        };
        if (req.method === 'HEAD') {
          cres.writeHead(200, headers);
          cres.end();
          return;
        }
        cres.writeHead(200, headers);
        cres.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>DIG store</title></head><body><h1>${MARKER}</h1><p>${url}</p></body></html>`);
        return;
      }
      // Probe / any other path → a plain 200 so resolveDigNode treats the node as reachable.
      cres.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'access-control-allow-origin': '*' });
      cres.end('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>fixture</title></head><body><main>fixture root</main></body></html>');
    });
    server.on('error', rej);
    server.listen(0, FIXTURE_HOST, () => {
      nodeBase = `http://${FIXTURE_HOST}:${(server.address() as AddressInfo).port}`;
      res();
    });
  });
}

async function setServerHost(page: Page, host: string): Promise<void> {
  await page.evaluate(async (h) => {
    await chrome.storage.local.set({ 'server.host': h });
  }, host);
}

async function setToolbar(page: Page, on: boolean): Promise<void> {
  await page.evaluate(async (v) => {
    await chrome.storage.local.set({ 'toolbar.enabled': v });
  }, on);
}

/** Set the toggle from the SW (chrome.storage is unavailable in a normal web page's MAIN world). */
async function setToolbarViaWorker(on: boolean): Promise<void> {
  await worker.evaluate(async (v) => {
    await chrome.storage.local.set({ 'toolbar.enabled': v });
  }, on);
}

/** Open the (extension) dig-viewer page — a chrome-extension:// tab with chrome.* access we can
 *  drive the SW from (mirrors the live-node harness's extPage). */
async function extPage(): Promise<Page> {
  const p = await context.newPage();
  await p.goto(`chrome-extension://${extensionId}/dig-viewer.html?urn=chia://${'c'.repeat(64)}/x`);
  return p;
}

/** Fire the real SW navigation for a chia:// URL against the active tab (the same path the omnibox
 *  Enter + address-bar interception drive → handleDigUrlNavigation → §5.3 node-or-sandbox). */
async function navigateToDigUrl(page: Page, digUrl: string): Promise<void> {
  await page.evaluate(
    (u) =>
      new Promise<void>((r) => {
        chrome.runtime.sendMessage({ action: 'navigateToDigUrl', url: u }, () => {
          void chrome.runtime.lastError;
          r();
        });
      }),
    digUrl,
  );
}

test.beforeAll(async () => {
  if (!existsSync(resolve(EXT_PATH, 'manifest.json'))) throw new Error(`run \`npm run build\` first — no ${EXT_PATH}`);
  await startFixture();
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    args: ['--headless=new', `--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`],
  });
  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extensionId = worker.url().split('/')[2];
});

test.afterAll(async () => {
  await context?.close();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
});

test('the manifest registers the `dig` omnibox keyword (#291)', async () => {
  const kw = await worker.evaluate(() => chrome.runtime.getManifest().omnibox?.keyword);
  expect(kw).toBe('dig');
});

test('#289 — local node reachable → the tab navigates to the node-served plaintext surface', async () => {
  const page = await extPage();
  await setServerHost(page, nodeBase); // genuine §5.3 override → the fixture node
  await navigateToDigUrl(page, CHIA_URL);

  // The tab is redirected to the node's plaintext /s/ surface — an ordinary http(s) website.
  await page.waitForURL((u) => u.pathname.startsWith(`/s/${STORE}/`), { timeout: 15_000 });
  const nav = new URL(page.url());
  expect(nav.protocol).toBe('http:');
  expect(page.url()).toBe(`${nodeBase}/s/${STORE}/index.html`);
  // The node-decrypted plaintext actually renders (not the sandbox viewer).
  await expect(page.locator('h1')).toHaveText(MARKER);
  await page.close();
});

test('#289 — no local node → keep the sandbox dig-viewer + rpc path (privacy)', async () => {
  const page = await extPage();
  await setServerHost(page, 'http://127.0.0.5:9'); // genuine override to a DEAD port → no local node
  await navigateToDigUrl(page, CHIA_URL);

  // With no reachable node the tab falls back to the extension's sandbox viewer (chrome-extension://),
  // never the node URL — a browser cannot get plaintext from the public gateway.
  await page.waitForURL((u) => u.pathname.startsWith('/dig-viewer.html'), { timeout: 15_000 });
  expect(new URL(page.url()).protocol).toBe('chrome-extension:');
  expect(page.url()).toContain('urn=');
  await page.close();
});

test('#292 — toolbar injects (shadow-DOM isolated) atop an ordinary page when the toggle is on', async () => {
  const cfg = await extPage();
  await setToolbar(cfg, true);
  await cfg.close();

  const page = await context.newPage();
  await page.goto(`${nodeBase}/plain`);
  // The injected toolbar is present and its bar (inside an OPEN shadow root) is visible.
  await expect(page.getByTestId('dig-toolbar')).toBeVisible({ timeout: 10_000 });
  // Shadow-DOM isolation: the host carries a shadowRoot; its contents are NOT in the page light DOM.
  const isolated = await page.evaluate(() => {
    const host = document.getElementById('dig-toolbar-host');
    return !!host?.shadowRoot && !document.body.innerText.includes('Wallet');
  });
  expect(isolated).toBe(true);
  await page.close();
});

test('#292 — toolbar icons open the full-page extension surfaces (#140/#141)', async () => {
  const cfg = await extPage();
  await setToolbar(cfg, true);
  await cfg.close();

  const page = await context.newPage();
  await page.goto(`${nodeBase}/plain`);
  await expect(page.getByTestId('dig-toolbar-icon-wallet')).toBeVisible({ timeout: 10_000 });

  const opened = context.waitForEvent('page');
  await page.getByTestId('dig-toolbar-icon-wallet').click();
  const walletTab = await opened;
  await walletTab.waitForLoadState('domcontentloaded').catch(() => {});
  expect(walletTab.url()).toContain('app.html');
  expect(walletTab.url()).toContain('#wallet');
  await walletTab.close();
  await page.close();
});

test('#292 — badges reflect the node serve headers on a node-served page; hidden off-network', async () => {
  const cfg = await extPage();
  await setToolbar(cfg, true);
  await cfg.close();

  // A node-served /s/ page: the node reported X-Dig-Verified:true + X-Dig-Source:local.
  const served = await context.newPage();
  await served.goto(`${nodeBase}/s/${STORE}/index.html`);
  await expect(served.getByTestId('dig-toolbar-badge-verified')).toBeVisible({ timeout: 10_000 });
  await expect(served.getByTestId('dig-toolbar-badge-verified')).toHaveAttribute('data-ok', 'true');
  await expect(served.getByTestId('dig-toolbar-badge-local')).toBeVisible();

  // Desktop + mobile screenshots for spacing inspection (§6.5).
  await served.setViewportSize({ width: 1280, height: 800 });
  await served.screenshot({ path: 'e2e/__screenshots__/toolbar-node-served-desktop.png', fullPage: true });
  await served.setViewportSize({ width: 390, height: 844 });
  await served.screenshot({ path: 'e2e/__screenshots__/toolbar-node-served-mobile.png', fullPage: true });
  await served.close();

  // An ordinary (non-node) page: the bar shows, but neither DIG-verdict badge does.
  const plain = await context.newPage();
  await plain.goto(`${nodeBase}/plain`);
  await expect(plain.getByTestId('dig-toolbar')).toBeVisible({ timeout: 10_000 });
  await expect(plain.getByTestId('dig-toolbar-badge-verified')).toHaveCount(0);
  await expect(plain.getByTestId('dig-toolbar-badge-local')).toHaveCount(0);
  await plain.close();
});

test('#292 — toggling the setting OFF removes the toolbar live', async () => {
  const cfg = await extPage();
  await setToolbar(cfg, true);
  await cfg.close();

  const page = await context.newPage();
  await page.goto(`${nodeBase}/plain`);
  await expect(page.getByTestId('dig-toolbar')).toBeVisible({ timeout: 10_000 });

  await setToolbarViaWorker(false); // storage.onChanged → live removal
  await expect(page.locator('#dig-toolbar-host')).toHaveCount(0, { timeout: 10_000 });
  await page.close();
});
