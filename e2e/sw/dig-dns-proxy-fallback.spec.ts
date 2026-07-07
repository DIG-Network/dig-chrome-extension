import { test, expect, chromium, type BrowserContext, type Worker, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';

/**
 * END-USER e2e for #175 (Component C of #174) — dig-dns Path-B proxy fallback.
 *
 * Proves, against the BUILT unpacked extension in a real browser, with a REAL (not mocked) tiny
 * loopback HTTP server standing in for dig-dns's gateway on `127.0.0.5:8053` (dig-dns's own `:80`→
 * `:8053` fallback port — unprivileged, so CI can bind it):
 *
 *  1. **Startup detection.** With the fake dig-dns gateway already answering when the SW starts,
 *     `getDigDnsStatus` reports `phase:'direct'` and the actual bound port — no proxy engaged.
 *  2. **Real navigation failure engages Path B.** `.dig` is not a real TLD, so navigating a page to
 *     `http://<label>.dig/` genuinely fails DNS resolution in this CI environment (no split-DNS is
 *     configured) — a REAL `net::ERR_NAME_NOT_RESOLVED`, no mocking needed. This fires the SW's real
 *     `webNavigation.onErrorOccurred` listener, which re-probes dig-dns and calls the REAL
 *     `chrome.proxy.settings.set` with a `pac_script` pointed at the fake gateway's `/.dig/proxy.pac`.
 *     Asserted two ways: `getDigDnsStatus` reports `phase:'proxy'`/`proxyActive:true`, AND
 *     `chrome.proxy.settings.get` (read from the SW) reflects the engaged PAC config.
 *  3. **Gateway gone → `unavailable`, proxy cleared.** Stopping the fake gateway and forcing a fresh
 *     probe (via `getDigDnsStatus`'s stale-snapshot refresh) reports `phase:'unavailable'` and clears
 *     the engaged proxy (a PAC pointed at a dead gateway would only break `.dig` traffic harder).
 *
 * The self-healing RECOVERY-STREAK arithmetic (N consecutive healthy probes) is exhaustively unit-
 * tested against an injected clock/fetch/chrome.proxy double in src/lib/dig-dns.test.ts — this e2e's
 * job is the browser-specific integration gap unit tests cannot cover: a REAL DNS failure reaching
 * the REAL `chrome.proxy` API end-to-end.
 *
 * Run: `npm run build && npm run test:sw`.
 */

const EXT_PATH = resolve(process.cwd(), 'dist');
const LOOPBACK_IP = '127.0.0.5';
const GATEWAY_PORT = 8053; // dig-dns's own deterministic :80 → :8053 fallback (SPEC.md §4)
const DOT_DIG_HOST = 'dig-dns-e2e-175.dig'; // not a real TLD — genuinely fails DNS in CI

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let extensionId: string;
let worker: Worker;
let fakeDigDns: Server;
/** Toggled per-test to flip the fake gateway between "answering" and "gone". */
let gatewayUp = true;

function startFakeDigDns(): Promise<Server> {
  return new Promise((resolvePromise, reject) => {
    const s = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (!gatewayUp) {
        req.destroy();
        return;
      }
      const url = req.url || '';
      if (url.startsWith('/.dig/resolve-probe')) {
        res.writeHead(204);
        res.end();
        return;
      }
      if (url.startsWith('/.dig/health')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok',
          version: '0.0.0-e2e',
          bound_port: GATEWAY_PORT,
          loopback_ip: LOOPBACK_IP,
          tld: 'dig',
          paths: { dns: false, gateway: true },
        }));
        return;
      }
      if (url.startsWith('/.dig/proxy.pac')) {
        res.writeHead(200, { 'content-type': 'application/x-ns-proxy-autoconfig' });
        res.end(`function FindProxyForURL(url, host) {\n  if (dnsDomainIs(host, ".dig")) return "PROXY ${LOOPBACK_IP}:${GATEWAY_PORT}";\n  return "DIRECT";\n}\n`);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    s.on('error', reject);
    s.listen(GATEWAY_PORT, LOOPBACK_IP, () => resolvePromise(s));
  });
}

function swSend<T>(page: Page, message: Record<string, unknown>): Promise<T> {
  return page.evaluate((msg) => new Promise<T>((res) => chrome.runtime.sendMessage(msg, res as (r: unknown) => void)), message);
}

test.beforeAll(async () => {
  if (!existsSync(resolve(EXT_PATH, 'manifest.json'))) {
    throw new Error(`Built extension not found at ${EXT_PATH} — run \`npm run build\` before the e2e.`);
  }
  gatewayUp = true;
  fakeDigDns = await startFakeDigDns();

  // Launch AFTER the fake gateway is already up, so the SW's own startup probe finds it live.
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    args: ['--headless=new', `--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`],
  });
  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extensionId = worker.url().split('/')[2];
});

test.afterAll(async () => {
  await context?.close();
  await new Promise<void>((res) => fakeDigDns?.close(() => res()));
});

test('reports phase "direct" with no proxy engaged when dig-dns answers at startup', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  const status = await swSend<{ phase?: string; boundPort?: number; proxyActive?: boolean }>(page, {
    action: 'getDigDnsStatus',
  });
  expect(status.phase).toBe('direct');
  expect(status.boundPort).toBe(GATEWAY_PORT);
  expect(status.proxyActive).toBe(false);
  await page.close();
});

test('a real .dig DNS failure engages the chrome.proxy PAC fallback', async () => {
  // A SEPARATE page carries the doomed navigation — Chrome tears down its execution context on a
  // hard nav failure, so it can't be reused for follow-up chrome.runtime.sendMessage calls.
  const triggerPage = await context.newPage();
  // `.dig` is not a registered TLD and no split-DNS is configured here, so this genuinely fails —
  // no route()/mocking involved. Playwright rejects goto() on a hard navigation error; that IS the
  // real net::ERR_NAME_NOT_RESOLVED the SW's webNavigation.onErrorOccurred listener also observes.
  await triggerPage.goto(`http://${DOT_DIG_HOST}/`).catch(() => {});

  const statusPage = await context.newPage();
  await statusPage.goto(`chrome-extension://${extensionId}/popup.html`);

  await expect
    .poll(
      async () => {
        const status = await swSend<{ phase?: string; proxyActive?: boolean }>(statusPage, { action: 'getDigDnsStatus' });
        return status.phase;
      },
      { timeout: 20_000, message: 'dig-dns controller never reached phase "proxy" after the real .dig DNS failure' },
    )
    .toBe('proxy');

  const status = await swSend<{ phase?: string; proxyActive?: boolean; pacUrl?: string }>(statusPage, { action: 'getDigDnsStatus' });
  expect(status.proxyActive).toBe(true);
  expect(status.pacUrl).toBe(`http://${LOOPBACK_IP}:${GATEWAY_PORT}/.dig/proxy.pac`);

  // Confirm the REAL chrome.proxy API reflects it (not just our own snapshot bookkeeping).
  const proxySettings = await worker.evaluate(
    () => new Promise((res) => chrome.proxy.settings.get({}, res)),
  ) as { value?: { mode?: string; pacScript?: { url?: string } } };
  expect(proxySettings.value?.mode).toBe('pac_script');
  expect(proxySettings.value?.pacScript?.url).toBe(`http://${LOOPBACK_IP}:${GATEWAY_PORT}/.dig/proxy.pac`);

  await triggerPage.close().catch(() => {});
  await statusPage.close();
});

test('when the gateway disappears, a fresh read reports "unavailable" and clears the proxy', async () => {
  gatewayUp = false;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);

  await expect
    .poll(
      async () => {
        const status = await swSend<{ phase?: string }>(page, { action: 'getDigDnsStatus' });
        return status.phase;
      },
      { timeout: 20_000, message: 'dig-dns controller never reached phase "unavailable" after the gateway went down' },
    )
    .toBe('unavailable');

  const status = await swSend<{ proxyActive?: boolean }>(page, { action: 'getDigDnsStatus' });
  expect(status.proxyActive).toBe(false);

  const proxySettings = await worker.evaluate(
    () => new Promise((res) => chrome.proxy.settings.get({}, res)),
  ) as { levelOfControl?: string; value?: { mode?: string } };
  // Cleared back to the browser's own default (no longer controlled by this extension).
  expect(proxySettings.value?.mode).not.toBe('pac_script');

  await page.close();
});
