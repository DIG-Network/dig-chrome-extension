import { test, expect, chromium, type BrowserContext, type Worker, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * #289 / #291 / #292 / #293 — the built extension, in real (headless) Chromium, proves the
 * node-serve navigation + injected toolbar batch END-TO-END against a FIXTURE dig-node (a local
 * HTTP server that answers the §5.3 reachability probe AND serves `/s/<store>[:root]/<path>` with
 * the DIG Shields `X-Dig-*` headers — standing in for a live node, which CI has none of):
 *
 *   #289 · with a local node reachable, a chia:// navigation lands the TAB DIRECTLY on the node's
 *          plaintext serve URL (`http://<node>/s/<store>/<path>`) — the real website, not the
 *          sandbox viewer. With NO local node, it keeps the sandbox dig-viewer + rpc path.
 *   #292/#293 · the toggle-gated toolbar injects atop an ordinary page (shadow-DOM isolated), styled
 *          as NATIVE browser chrome (neutral grey, no DIG gradient); its dedicated `chia://`/URN
 *          address bar feeds the SAME node-or-sandbox navigation on Enter; its ONE button opens the
 *          fullscreen extension surface; its badges light up from the node's `X-Dig-*` headers on a
 *          node-served page; toggling off removes it live.
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

/** Set the persisted theme mode (#429/#111) via the shared `wallet.settings` blob (read-modify-write
 *  so unrelated settings survive) from an extension page with chrome.storage access. */
async function setThemeMode(page: Page, mode: 'light' | 'dark' | 'system'): Promise<void> {
  await page.evaluate(async (m) => {
    const cur = ((await chrome.storage.local.get('wallet.settings'))['wallet.settings'] as Record<string, unknown>) || {};
    await chrome.storage.local.set({ 'wallet.settings': { ...cur, theme: m } });
  }, mode);
}

/** Set the URN bar's OWN independent theme preference (#459) — a FLAT `toolbar.theme` key, never
 *  the `wallet.settings` blob the app theme lives in. */
async function setToolbarThemeMode(page: Page, mode: 'light' | 'dark' | 'system'): Promise<void> {
  await page.evaluate(async (m) => {
    await chrome.storage.local.set({ 'toolbar.theme': m });
  }, mode);
}

/** Open the (extension) dig-viewer page — a chrome-extension:// tab with chrome.* access we can
 *  drive the SW from (mirrors the live-node harness's extPage). */
async function extPage(): Promise<Page> {
  const p = await context.newPage();
  await p.goto(`chrome-extension://${extensionId}/dig-viewer.html?urn=chia://${'c'.repeat(64)}/x`);
  return p;
}

/** Fire the real SW navigation for a chia:// URL against the active tab (the same path the omnibox
 *  Enter + address-bar interception drive → handleDigUrlNavigation → §5.3 node-or-sandbox). The
 *  message is fire-and-forget: it navigates THIS tab, so awaiting the sendMessage callback would race
 *  the navigation destroying the page's execution context — the assertion is the resulting tab URL. */
async function navigateToDigUrl(page: Page, digUrl: string): Promise<void> {
  await page
    .evaluate((u) => {
      chrome.runtime.sendMessage({ action: 'navigateToDigUrl', url: u });
    }, digUrl)
    .catch(() => {
      /* context may already be tearing down from the navigation — the waitForURL is the assertion */
    });
}

/** Fire the shared classify→resolve→navigate core for ANY raw input (#362) against the active tab —
 *  the path the raw `urn:`/`chia://` interception (#310) + the toolbar on-dig-net form (#306) use. */
async function navigateDigInput(page: Page, input: string): Promise<void> {
  await page
    .evaluate((i) => {
      chrome.runtime.sendMessage({ action: 'navigateDigInput', input: i });
    }, input)
    .catch(() => {
      /* the navigation may tear the context down — the waitForURL is the assertion */
    });
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
  // `waitUntil: 'commit'` (NOT the default 'load') is load-bearing: the SW navigates the tab through a
  // CHAIN (dig-loader.html → the destination), so the intermediate hop's `load` event is aborted by
  // the very next navigation (`net::ERR_ABORTED; maybe frame was detached?` — the #600/#646 flake).
  // Asserting on URL COMMIT resolves the moment the destination commits, immune to that abort race.
  await page.waitForURL((u) => u.pathname.startsWith(`/s/${STORE}/`), { timeout: 15_000, waitUntil: 'commit' });
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
  await page.waitForURL((u) => u.pathname.startsWith('/dig-viewer.html'), { timeout: 15_000, waitUntil: 'commit' });
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
  // Shadow-DOM isolation: the host carries a shadowRoot, and the bar is reachable ONLY through it —
  // a plain LIGHT-DOM query (which cannot pierce a shadow boundary) finds nothing.
  const isolated = await page.evaluate(() => {
    const host = document.getElementById('dig-toolbar-host');
    return !!host?.shadowRoot && document.querySelector('[data-testid="dig-toolbar"]') === null;
  });
  expect(isolated).toBe(true);
  await page.close();
});

test('#293 — the bar is native-grey, not the DIG gradient (must read as browser chrome)', async () => {
  const cfg = await extPage();
  await setToolbar(cfg, true);
  await cfg.close();

  const page = await context.newPage();
  await page.goto(`${nodeBase}/plain`);
  await expect(page.getByTestId('dig-toolbar')).toBeVisible({ timeout: 10_000 });
  const bg = await page.evaluate(() => {
    const host = document.getElementById('dig-toolbar-host');
    const bar = host?.shadowRoot?.querySelector('.bar');
    return bar ? getComputedStyle(bar).backgroundImage + '|' + getComputedStyle(bar).backgroundColor : null;
  });
  expect(bg).not.toBeNull();
  expect(bg).not.toContain('gradient'); // no DIG brand gradient
  expect(bg).toContain('rgb(241, 243, 244)'); // #f1f3f4 — neutral Chrome-toolbar grey
  await page.close();
});

test('#293 — the URN address bar resolves a typed chia:// value on Enter via the SAME node-or-sandbox path', async () => {
  const cfg = await extPage();
  await setToolbar(cfg, true);
  await setServerHost(cfg, nodeBase); // genuine §5.3 override → the fixture node
  await cfg.close();

  const page = await context.newPage();
  await page.goto(`${nodeBase}/plain`);
  const input = page.getByTestId('dig-toolbar-urn-input');
  await expect(input).toBeVisible({ timeout: 10_000 });
  // Placeholder makes clear this is a URN bar, not the page's own address bar.
  await expect(input).toHaveAttribute('placeholder', /chia:\/\/.*DIG URN/);

  await input.fill(CHIA_URL);
  await input.press('Enter');

  // Enter feeds handleDigUrlNavigation — with the fixture node reachable, the tab lands on the
  // node-served plaintext surface (the same #289 path the omnibox/nav use).
  await page.waitForURL((u) => u.pathname.startsWith(`/s/${STORE}/`), { timeout: 15_000, waitUntil: 'commit' });
  expect(page.url()).toBe(`${nodeBase}/s/${STORE}/index.html`);
  await expect(page.locator('h1')).toHaveText(MARKER);
});

test('#293 — an invalid URN-bar value shows an inline error and does not navigate', async () => {
  const cfg = await extPage();
  await setToolbar(cfg, true);
  await cfg.close();

  const page = await context.newPage();
  await page.goto(`${nodeBase}/plain`);
  const input = page.getByTestId('dig-toolbar-urn-input');
  await expect(input).toBeVisible({ timeout: 10_000 });

  await input.fill('not a valid urn');
  await input.press('Enter');
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByTestId('dig-toolbar-urn-error')).toHaveText(/not a valid/i);
  // Never navigated away from the fixture's plain page.
  expect(page.url()).toBe(`${nodeBase}/plain`);
  await page.close();
});

test('#293 — the single button opens the fullscreen extension surface (replaces the old icon row)', async () => {
  const cfg = await extPage();
  await setToolbar(cfg, true);
  await cfg.close();

  const page = await context.newPage();
  await page.goto(`${nodeBase}/plain`);
  await expect(page.getByTestId('dig-toolbar-open')).toBeVisible({ timeout: 10_000 });
  // The old per-page Wallet/Shields/Control icon row is gone.
  await expect(page.getByTestId('dig-toolbar-icon-wallet')).toHaveCount(0);

  const opened = context.waitForEvent('page');
  await page.getByTestId('dig-toolbar-open').click();
  const fullscreenTab = await opened;
  await fullscreenTab.waitForLoadState('domcontentloaded').catch(() => {});
  expect(fullscreenTab.url()).toContain('app.html');
  await fullscreenTab.close();
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

// ── #306 — the header toggle-switch + the built-in fullscreen URN toolbar ──────────────────────────

test('#306 — the header control is a role="switch" that turns the built-in toolbar on/off live', async () => {
  const cfg = await extPage();
  await setToolbar(cfg, false);
  await cfg.close();

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/app.html`);
  const sw = page.getByTestId('header-toolbar-toggle');
  await expect(sw).toBeVisible({ timeout: 10_000 });
  await expect(sw).toHaveAttribute('role', 'switch'); // a switch, NOT a checkbox (#306 item 3)
  await expect(sw).toHaveAttribute('aria-checked', 'false');
  // Off → the built-in toolbar is not mounted.
  await expect(page.getByTestId('builtin-dig-toolbar')).toHaveCount(0);
  // Flip it on from the header → the built-in URN bar appears live (same toolbar.enabled key).
  await sw.click();
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('builtin-dig-toolbar')).toBeVisible({ timeout: 10_000 });
  await page.close();
});

test('#306 — the built-in fullscreen URN bar resolves a chia:// value through the local node', async () => {
  const cfg = await extPage();
  await setToolbar(cfg, true);
  await setServerHost(cfg, nodeBase); // §5.3 override → the fixture node
  await cfg.close();

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/app.html`);
  const input = page.getByTestId('builtin-dig-toolbar-urn-input');
  await expect(input).toBeVisible({ timeout: 10_000 });
  await input.fill(CHIA_URL);
  await input.press('Enter');
  await page.waitForURL((u) => u.pathname.startsWith(`/s/${STORE}/`), { timeout: 15_000, waitUntil: 'commit' });
  expect(page.url()).toBe(`${nodeBase}/s/${STORE}/index.html`);
  await expect(page.locator('h1')).toHaveText(MARKER);
  await page.close();
});

// ── #310 — the bare urn:dig:chia: form routes through the shared core to the node serve ─────────────

test('#310/#362 — a bare urn:dig:chia: input resolves via the shared core to the node-served surface', async () => {
  const page = await extPage();
  await setServerHost(page, nodeBase);
  await navigateDigInput(page, `urn:dig:chia:${STORE}/index.html`);
  await page.waitForURL((u) => u.pathname.startsWith(`/s/${STORE}/`), { timeout: 15_000, waitUntil: 'commit' });
  expect(page.url()).toBe(`${nodeBase}/s/${STORE}/index.html`);
  await expect(page.locator('h1')).toHaveText(MARKER);
  await page.close();
});

// ── #362 Tier 4 — the custom DIG search resolver page ───────────────────────────────────────────────

test('#362 — the DIG search resolver loads a DIG query through the local node', async () => {
  const cfg = await extPage();
  await setServerHost(cfg, nodeBase);
  await cfg.close();

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/dig-search.html?q=${encodeURIComponent(CHIA_URL)}`);
  await page.waitForURL((u) => u.pathname.startsWith(`/s/${STORE}/`), { timeout: 15_000, waitUntil: 'commit' });
  expect(page.url()).toBe(`${nodeBase}/s/${STORE}/index.html`);
  await expect(page.locator('h1')).toHaveText(MARKER);
  await page.close();
});

test('#362 — the DIG search resolver sends a NON-DIG query to the configured fallback engine (loop-free)', async () => {
  const page = await context.newPage();
  // Stub DuckDuckGo so the assertion is offline-robust: we only prove the resolver redirects THERE.
  await page.route('https://duckduckgo.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>ddg</title>ok' }),
  );
  await page.goto(`chrome-extension://${extensionId}/dig-search.html?q=${encodeURIComponent('best chia wallet')}`);
  await page.waitForURL(/duckduckgo\.com/, { timeout: 15_000, waitUntil: 'commit' });
  expect(page.url()).toContain('duckduckgo.com/?q=');
  expect(decodeURIComponent(page.url())).toContain('best chia wallet');
  await page.close();
});

// ── #311 — the instant DIG loader interstitial ──────────────────────────────────────────────────────

test('#311 — a URN-bar submit paints the DIG loader instantly, then swaps to the resolved content', async () => {
  const cfg = await extPage();
  await setToolbar(cfg, true);
  // A DEAD node port makes the §5.3 probe take its full ~1.2s timeout — a REAL resolve latency the
  // loader is designed to cover — so the interstitial is deterministically visible for >1s (no race
  // with an instant swap), then the tab settles on the sandbox dig-viewer. This is the honest proof
  // of the never-blank loader; the fast node-reachable swap is covered by #289/#293 above.
  await setServerHost(cfg, 'http://127.0.0.5:9');
  await cfg.close();

  const page = await context.newPage();
  await page.goto(`${nodeBase}/plain`);
  // Record every main-frame navigation. The loader is a TRANSIENT interstitial the SW swaps away
  // once the resolve completes, so asserting its DOM on the live tab races the swap; the reliable
  // proof is the navigation SEQUENCE (the ~1.2s probe guarantees the loader hop fully commits →
  // `framenavigated` fires for it) — the loader's own DOM render is proven by the direct-navigation
  // test below.
  const visited: string[] = [];
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) visited.push(frame.url());
  });

  const input = page.getByTestId('dig-toolbar-urn-input');
  await expect(input).toBeVisible({ timeout: 10_000 });
  await input.fill(CHIA_URL);
  await input.press('Enter');

  // The SW settles the tab on the resolved destination (no local node → the sandbox dig-viewer).
  await page.waitForURL((u) => u.pathname.endsWith('/dig-viewer.html'), { timeout: 20_000, waitUntil: 'commit' });
  expect(page.url()).toContain('urn=');

  // The branded DIG loader was flashed FIRST (an extension page), as an instant never-blank
  // interstitial, BEFORE the destination — proven by the recorded sequence (loader precedes viewer).
  const loaderIdx = visited.findIndex((u) => u.includes('/dig-loader.html'));
  const viewerIdx = visited.findIndex((u) => u.includes('/dig-viewer.html'));
  expect(loaderIdx, `loader hop in ${JSON.stringify(visited)}`).toBeGreaterThanOrEqual(0);
  expect(loaderIdx).toBeLessThan(viewerIdx);
  await page.close();
});

test('#311 — the loader page renders the branded shell directly (screenshots, light + dark)', async () => {
  const page = await context.newPage();
  const loaderUrl = `chrome-extension://${extensionId}/dig-loader.html?input=${encodeURIComponent(CHIA_URL)}`;
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const w of [
      { label: 'desktop', size: { width: 1280, height: 820 } },
      { label: 'mobile', size: { width: 390, height: 780 } },
    ]) {
      await page.setViewportSize(w.size);
      await page.goto(loaderUrl);
      await expect(page.getByTestId('dig-loader-page')).toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId('dig-loader-spinner')).toBeVisible();
      await page.screenshot({ path: `e2e/__screenshots__/dig-loader-${scheme}-${w.label}.png` });
    }
  }
  await page.close();
});

// ── #366 — toolbar hide control + keyboard show/hide + shortcut hint ──────────────────────────────────

test('#366 — the injected toolbar shows a shortcut hint and the hide button removes it live', async () => {
  const cfg = await extPage();
  await setToolbar(cfg, true);
  await cfg.close();

  const page = await context.newPage();
  await page.goto(`${nodeBase}/plain`);
  await expect(page.getByTestId('dig-toolbar')).toBeVisible({ timeout: 10_000 });

  // The muted show/hide shortcut hint is present in the bar (default Alt+Shift+D until rebinding).
  await expect(page.getByTestId('dig-toolbar-shortcut-hint')).toContainText('Alt+Shift+D');

  // Clicking hide flips toolbar.enabled off → the bar is removed live on this page.
  await page.getByTestId('dig-toolbar-hide').click();
  await expect(page.locator('#dig-toolbar-host')).toHaveCount(0, { timeout: 10_000 });

  // The persisted toggle is now off (a fresh page does NOT inject the bar).
  const enabled = await worker.evaluate(async () => (await chrome.storage.local.get('toolbar.enabled'))['toolbar.enabled']);
  expect(enabled).toBe(false);
  await page.close();
});

test('#366 — re-enabling toolbar.enabled (as the header switch/keyboard command do) re-injects the bar', async () => {
  const page = await context.newPage();
  await page.goto(`${nodeBase}/plain`);
  // Off from the previous test → no bar.
  await expect(page.getByTestId('dig-toolbar')).toHaveCount(0, { timeout: 10_000 });
  // Flip it back on via the SAME storage key the header switch + chrome.commands listener drive.
  await setToolbarViaWorker(true);
  await expect(page.getByTestId('dig-toolbar')).toBeVisible({ timeout: 10_000 });
  await page.close();
});

test('#366 — the manifest registers the toggle-dig-toolbar keyboard command (Alt+Shift+D default)', async () => {
  const cmd = await worker.evaluate(() => {
    const cmds = chrome.runtime.getManifest().commands || {};
    return cmds['toggle-dig-toolbar'];
  });
  expect(cmd).toBeTruthy();
  expect(cmd?.suggested_key?.default).toBe('Alt+Shift+D');
});

// ── #306 item 2 — screenshots: the built-in toolbar light + dark, desktop + mobile (§6.5) ───────────

test('#306 — screenshot the built-in toolbar + header switch (light/dark, desktop/mobile)', async () => {
  const cfg = await extPage();
  await setToolbar(cfg, true);
  // #429/#459: the built-in bar paints from its OWN independent, persisted theme pref
  // (`toolbar.theme`), not raw prefers-color-scheme and not the app theme — so put THAT pref in
  // `system` here to keep this test's OS-signal (emulateMedia) light/dark shots valid.
  await setToolbarThemeMode(cfg, 'system');
  await cfg.close();

  const page = await context.newPage();
  const widths = [
    { label: 'desktop', size: { width: 1280, height: 820 } },
    { label: 'mobile', size: { width: 390, height: 780 } },
  ];
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const w of widths) {
      await page.setViewportSize(w.size);
      await page.goto(`chrome-extension://${extensionId}/app.html`);
      await expect(page.getByTestId('builtin-dig-toolbar')).toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId('header-toolbar-toggle')).toBeVisible();
      await page.screenshot({ path: `e2e/__screenshots__/urn-toolbar-${scheme}-${w.label}.png` });
    }
  }
  await page.close();
});

// ── #429 — the light/dark theme switcher button in the built-in URN bar ─────────────────────────────

test('#429/#459 — the URN-bar theme toggle flips light↔dark, persists under its OWN key, and survives reload — WITHOUT touching the app theme', async () => {
  const cfg = await extPage();
  await setToolbar(cfg, true);
  await setThemeMode(cfg, 'light'); // app theme known start (the #211 product default)
  await setToolbarThemeMode(cfg, 'light'); // URN-bar theme known start, independently
  await cfg.close();

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/app.html`);

  const bar = page.getByTestId('builtin-dig-toolbar');
  const toggle = page.getByTestId('builtin-dig-toolbar-theme-toggle');
  await expect(bar).toBeVisible({ timeout: 10_000 });
  await expect(toggle).toBeVisible();

  // Starts light both ways: bar painted light, toggle not pressed, the ext page itself is light.
  await expect(bar).toHaveAttribute('data-theme', 'light');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect
    .poll(async () => page.evaluate(() => document.documentElement.dataset.digTheme))
    .toBe('light');

  // One tap → dark: the bar repaints immediately; the REST of the ext page (app theme) is UNCHANGED
  // (#459 — the bug this ticket fixes was the toggle also flipping document.dataset.digTheme).
  await toggle.click();
  await expect(bar).toHaveAttribute('data-theme', 'dark');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect
    .poll(async () => page.evaluate(() => document.documentElement.dataset.digTheme))
    .toBe('light');

  // Persisted to the toolbar's OWN key (real chrome.storage — survives reload) — NEVER
  // wallet.settings.theme, which stays exactly what the app-theme control last set (light).
  const toolbarPersisted = await worker.evaluate(async () => (await chrome.storage.local.get('toolbar.theme'))['toolbar.theme']);
  expect(toolbarPersisted).toBe('dark');
  const appPersisted = await worker.evaluate(
    async () => ((await chrome.storage.local.get('wallet.settings'))['wallet.settings'] as { theme?: string })?.theme,
  );
  expect(appPersisted).toBe('light');

  // Reload the extension page: the URN-bar choice sticks (hydrated from its own key on boot); the
  // app theme is still light.
  await page.reload();
  await expect(page.getByTestId('builtin-dig-toolbar')).toHaveAttribute('data-theme', 'dark', { timeout: 10_000 });
  await expect(page.getByTestId('builtin-dig-toolbar-theme-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect
    .poll(async () => page.evaluate(() => document.documentElement.dataset.digTheme))
    .toBe('light');
  await page.close();
});

test('#429/#459 — screenshot the URN-bar theme toggle in both light + dark (desktop/mobile)', async () => {
  const cfg = await extPage();
  await setToolbar(cfg, true);
  await cfg.close();

  const page = await context.newPage();
  const widths = [
    { label: 'desktop', size: { width: 1200, height: 820 } },
    { label: 'mobile', size: { width: 372, height: 780 } },
  ];
  for (const mode of ['light', 'dark'] as const) {
    const setter = await extPage();
    await setToolbarThemeMode(setter, mode); // the URN bar's OWN independent pref drives the bar
    await setter.close();
    for (const w of widths) {
      await page.setViewportSize(w.size);
      await page.goto(`chrome-extension://${extensionId}/app.html`);
      await expect(page.getByTestId('builtin-dig-toolbar')).toHaveAttribute('data-theme', mode, { timeout: 10_000 });
      await expect(page.getByTestId('builtin-dig-toolbar-theme-toggle')).toBeVisible();
      await page.screenshot({ path: `e2e/__screenshots__/urn-theme-toggle-${mode}-${w.label}.png` });
    }
  }
  await page.close();
});

// ── #459 — the URN-bar theme is decoupled from the main app theme ──────────────────────────────────

test('#459 — the URN-bar theme is independent of the app theme, proven in BOTH directions', async () => {
  const cfg = await extPage();
  await setToolbar(cfg, true);
  await setThemeMode(cfg, 'light');
  await setToolbarThemeMode(cfg, 'light');
  await cfg.close();

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/app.html`);

  const bar = page.getByTestId('builtin-dig-toolbar');
  const toggle = page.getByTestId('builtin-dig-toolbar-theme-toggle');
  const themeSelect = page.getByTestId('theme-select');
  await expect(bar).toBeVisible({ timeout: 10_000 });
  await expect(themeSelect).toHaveValue('light');
  await expect(bar).toHaveAttribute('data-theme', 'light');

  // Direction 1: flip the APP theme via the real footer control (AppFooter's <select>, #111) — the
  // URN bar must NOT move.
  await themeSelect.selectOption('dark');
  await expect
    .poll(async () => page.evaluate(() => document.documentElement.dataset.digTheme))
    .toBe('dark');
  await expect(bar).toHaveAttribute('data-theme', 'light'); // unaffected
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');

  // Direction 2: flip the URN-bar toggle — the app theme (still on 'dark' from step 1) must NOT move.
  await toggle.click();
  await expect(bar).toHaveAttribute('data-theme', 'dark');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(themeSelect).toHaveValue('dark'); // unchanged by the toolbar toggle
  await expect
    .poll(async () => page.evaluate(() => document.documentElement.dataset.digTheme))
    .toBe('dark');

  // Prove it's genuine decoupling, not coincidence: diverge them (app → light, toolbar stays dark)
  // and confirm the toolbar is untouched by the app-theme flip back.
  await themeSelect.selectOption('light');
  await expect
    .poll(async () => page.evaluate(() => document.documentElement.dataset.digTheme))
    .toBe('light');
  await expect(bar).toHaveAttribute('data-theme', 'dark');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');

  await page.close();
});

test('#459 — the INJECTED content-script toolbar reads the SAME independent theme key, live, and never touches the app theme', async () => {
  await setToolbarViaWorker(true);
  // Clear the app-theme blob so a stray leftover value from an earlier test can't hide a coupling bug.
  await worker.evaluate(async () => {
    await chrome.storage.local.remove('wallet.settings');
    await chrome.storage.local.set({ 'toolbar.theme': 'dark' });
  });

  const page = await context.newPage();
  await page.goto(`${nodeBase}/plain`);
  const bar = page.getByTestId('dig-toolbar');
  await expect(bar).toBeVisible({ timeout: 10_000 });
  // Shares the SAME persisted key the built-in fullscreen bar's switcher writes.
  await expect(bar).toHaveAttribute('data-theme', 'dark');
  await page.screenshot({ path: 'e2e/__screenshots__/toolbar-injected-theme-dark.png' });

  // Live-sync: flipping the shared key (as the fullscreen switcher would) repaints THIS mount too,
  // with no reload/navigation — the same chrome.storage.onChanged wiring the enable toggle uses.
  await worker.evaluate(async () => {
    await chrome.storage.local.set({ 'toolbar.theme': 'light' });
  });
  await expect(bar).toHaveAttribute('data-theme', 'light', { timeout: 10_000 });
  await page.screenshot({ path: 'e2e/__screenshots__/toolbar-injected-theme-light.png' });

  // Never wrote to the app-theme blob (#459 decoupling — the injected mount has no Redux store).
  const walletSettings = await worker.evaluate(async () => (await chrome.storage.local.get('wallet.settings'))['wallet.settings']);
  expect(walletSettings).toBeUndefined();

  await page.close();
});
