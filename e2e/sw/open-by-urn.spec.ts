import { test, expect, chromium, type BrowserContext, type Worker, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

/**
 * END-USER e2e for #172 — the Home screen "open a chia:// address or DIG URN" input, driven
 * against the BUILT unpacked extension in a real browser with a REAL background service worker
 * (real `getLockState`/`getCustodyBalances`/etc. plumbing, real `navigateToDigUrl` redirect
 * machinery). Proves the dig-dns-detect branch from the issue's clarifying comments:
 *
 *   1. dig-dns UNREACHABLE (`getDigDnsStatus` phase `unavailable`, the real default when nothing
 *      answers on the loopback) -> the input hands the canonical `chia://` URL to the REAL
 *      background `navigateToDigUrl` action, which redirects THIS SAME tab to `dig-viewer.html` —
 *      the extension's own chrome-extension:// content view (the branded-loader page, #157) — never
 *      a new tab, never the resource's own origin.
 *   2. dig-dns REACHABLE (`phase: 'direct'`) -> the input navigates the active tab to the native
 *      `http://<base32-storeId>.dig/` address instead.
 *
 * `getDigDnsStatus`'s reply is MOCKED (an init-script wrapper around `chrome.runtime.sendMessage`
 * that intercepts only that one action, passing every other action through to the REAL SW) — per
 * the issue's own acceptance note that the `.dig`-scheme path "may need ... a mock of the
 * availability signal" in a test env with no real dig-dns service. The self-healing probe/PAC state
 * machine itself is exhaustively unit-tested (src/lib/dig-dns.test.ts) and browser-integration-tested
 * against a real fake gateway (e2e/sw/dig-dns-proxy-fallback.spec.ts) — this file's job is proving
 * #172's NEW branch decision + navigation, not re-proving dig-dns detection itself.
 *
 * `chrome.tabs.update` is also wrapped to RECORD every call (so the `.dig`-scheme assertion doesn't
 * depend on a real — and here undeliverable — `.dig` DNS/proxy answer) while still forwarding to the
 * real API, so the content-view case's real tab redirect to `dig-viewer.html` is still observed.
 *
 * Run: `npm run build && npm run test:sw`.
 */

const EXT_PATH = resolve(process.cwd(), 'dist');
const STORE_ID = 'd'.repeat(64);
// base32 label for 32 bytes of 0xDD (hex "d".repeat(64)) — computed + pinned in open-urn.test.ts's
// sibling fixtures style; dig-dns-host.test.ts independently proves the codec against the dig-dns
// Rust vectors.
const STORE_LABEL = '3xo53xo53xo53xo53xo53xo53xo53xo53xo53xo53xo53xo53xoq';

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let extensionId: string;
let worker: Worker;

/** Wrap `chrome.runtime.sendMessage` (mock ONLY `getDigDnsStatus`) + `chrome.tabs.update` (record
 *  every call, still forward it) BEFORE the page's own scripts run. Also no-ops `window.close()`:
 *  the widget calls it after firing the content-view navigation (matching the Resolver tab's own
 *  `openUrl`, correct for a REAL action popup, where `chrome.tabs.query({active,currentWindow})`
 *  never returns the popup itself); loading `popup.html` as a plain Playwright PAGE (this harness's
 *  only way to drive it) makes that same page the queried "active tab" too, and this headless
 *  Chromium permits a plain tab to self-close via script — racing the background's async redirect
 *  and tearing the page down before we can observe it. Test-harness-only; no product code change. */
async function withMockedDigDnsAndTabCapture(page: Page, digDnsReply: unknown): Promise<void> {
  await page.addInitScript((reply) => {
    window.close = () => {};
    const realSend = chrome.runtime.sendMessage.bind(chrome.runtime);
    // @ts-expect-error - overriding the extension API surface for the test harness
    chrome.runtime.sendMessage = (msg: { action?: string }, cb?: (r: unknown) => void) => {
      if (msg && msg.action === 'getDigDnsStatus') {
        if (typeof cb === 'function') {
          cb(reply);
          return undefined;
        }
        return Promise.resolve(reply);
      }
      return realSend(msg, cb as never);
    };
    // Record-only (never forwarded): the `.dig`-scheme target is never resolvable in this test
    // env (no real dig-dns/DNS), so actually letting the page attempt the navigation would replace
    // the document mid-test, wiping this very state before it can be read back. This call happens
    // in the POPUP's own page context (OpenByUrnInput's `openInActiveTab`), NOT the background SW —
    // the content-view test's real tab redirect goes through the SW's own unpatched `chrome.tabs
    // .update`, which this does not touch.
    (window as unknown as { __capturedTabUpdates: unknown[] }).__capturedTabUpdates = [];
    // @ts-expect-error - overriding the extension API surface for the test harness
    chrome.tabs.update = (tabId: number, updateProps: { url?: string }, cb?: (t: unknown) => void) => {
      (window as unknown as { __capturedTabUpdates: unknown[] }).__capturedTabUpdates.push({ tabId, updateProps });
      if (typeof cb === 'function') cb({});
      return Promise.resolve({});
    };
  }, digDnsReply);
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

test('dig-dns unreachable: opens the address in the chrome-extension:// content view (dig-viewer.html)', async () => {
  const page = await context.newPage();
  await withMockedDigDnsAndTabCapture(page, {
    phase: 'unavailable', boundPort: null, pacUrl: null, loopbackIp: '127.0.0.5', proxyActive: false, lastProbeAt: 1, lastError: null,
  });
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  // #289: a chia:// nav now routes to a LOCAL node's plaintext /s/ surface when one is reachable.
  // This test asserts the sandbox dig-viewer path, so pin a dead custom-node override (a non-alias
  // loopback + dead port wins the §5.3 ladder, then fails to connect) → no local node → sandbox,
  // deterministically, whether or not a dig-node happens to be running on the test machine.
  await page.evaluate(() => chrome.storage.local.set({ 'server.host': 'http://127.0.0.5:9' }));

  await page.getByTestId('home-openurn-input').fill(`chia://${STORE_ID}`);
  await page.screenshot({ path: 'e2e/__screenshots__/open-by-urn-home-input.png' });
  await page.getByTestId('home-openurn-go').click();

  // The background's REAL navigateToDigUrl handler redirects THIS tab to dig-viewer.html — never a
  // new tab, never the resource's own origin.
  await page.waitForURL((url) => url.pathname.startsWith('/dig-viewer.html'), { timeout: 15_000 });
  const url = new URL(page.url());
  expect(url.protocol).toBe('chrome-extension:');
  expect(url.pathname).toBe('/dig-viewer.html');
  // The background's navigateToDigUrl strips the leading `chia://` SCHEME (not the `chia:` chain
  // prefix) before building the viewer's `?urn=` param — `dig-viewer.ts`'s own parseURN tolerates
  // either form, so this is just the real, observed on-the-wire shape.
  expect(decodeURIComponent(url.searchParams.get('urn') ?? '')).toBe(`chia:${STORE_ID}/index.html`);
  await page.screenshot({ path: 'e2e/__screenshots__/open-by-urn-content-view.png' });

  await page.close();
});

test('dig-dns reachable (phase "direct"): navigates the active tab to the native .dig scheme', async () => {
  const page = await context.newPage();
  await withMockedDigDnsAndTabCapture(page, {
    phase: 'direct', boundPort: 80, pacUrl: null, loopbackIp: '127.0.0.5', proxyActive: false, lastProbeAt: 1, lastError: null,
  });
  await page.goto(`chrome-extension://${extensionId}/popup.html`);

  await page.getByTestId('home-openurn-input').fill(`chia://${STORE_ID}`);
  await page.getByTestId('home-openurn-go').click();

  await expect
    .poll(
      () => page.evaluate(() => (window as unknown as { __capturedTabUpdates: { updateProps?: { url?: string } }[] }).__capturedTabUpdates.length),
      { timeout: 10_000, message: 'chrome.tabs.update was never called for the .dig-scheme navigation' },
    )
    .toBeGreaterThan(0);

  const captured = await page.evaluate(
    () => (window as unknown as { __capturedTabUpdates: { updateProps?: { url?: string } }[] }).__capturedTabUpdates,
  );
  expect(captured[0]?.updateProps?.url).toBe(`http://${STORE_LABEL}.dig/`);

  await page.close();
});

test('an invalid, non-empty address shows the inline error and never navigates', async () => {
  const page = await context.newPage();
  await withMockedDigDnsAndTabCapture(page, { phase: 'unavailable' });
  await page.goto(`chrome-extension://${extensionId}/popup.html`);

  await page.getByTestId('home-openurn-input').fill('not a valid address');
  await page.getByTestId('home-openurn-go').click();
  await expect(page.getByTestId('home-openurn-error')).toBeVisible();
  await page.screenshot({ path: 'e2e/__screenshots__/open-by-urn-invalid-error.png' });
  expect(page.url()).toContain('popup.html');

  await page.close();
});
