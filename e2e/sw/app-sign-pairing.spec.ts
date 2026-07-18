import { test, expect, chromium, type BrowserContext, type Worker, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { startMockAppWsServer, type MockAppWsServer } from './support/mock-app-ws-server';

/**
 * END-USER e2e for SIGN-4 (#950) — the APP-SIGN dig-app paired identity/signing channel.
 *
 * The real dig-app side (SIGN-1/2/3) is not merged yet, so this loads the BUILT extension in a real
 * browser and round-trips it against a MOCK dig-app WebSocket server that speaks the SPEC §5.6 wire
 * (a real `ws://127.0.0.1:9779` socket — proving the wire works through a real browser WebSocket, not
 * just a fake). It proves:
 *   - pair → connect → sign round-trips over the paired channel;
 *   - the server's per-frame auth-MAC verification passes (canonical_json + HMAC agree byte-for-byte);
 *   - THE TRUE-ORIGIN PASSTHROUGH (the security crux, SPEC §7.1): a page-supplied `origin` in the
 *     request params is IGNORED — the SW relays the browser-COMMITTED `sender.origin`.
 *
 * A real-dig-app e2e (native confirm + biometric) is a follow-up once SIGN-1/2/3 land.
 *
 * Run: `npm run build && npm run test:sw`.
 */

const EXT_PATH = resolve(process.cwd(), 'dist');

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let extensionId: string;
let worker: Worker;
let extPage: Page;
let mock: MockAppWsServer;

/** Send a chrome.runtime message from an EXTENSION page (so `sender.origin` is the extension origin). */
function swSend<T>(page: Page, message: Record<string, unknown>): Promise<T> {
  return page.evaluate(
    (msg) => new Promise<T>((res) => chrome.runtime.sendMessage(msg, res as (r: unknown) => void)),
    message,
  );
}

test.beforeAll(async () => {
  if (!existsSync(resolve(EXT_PATH, 'manifest.json'))) {
    throw new Error(`Built extension not found at ${EXT_PATH} — run \`npm run build\` before the e2e.`);
  }
  // Start the mock dig-app endpoint BEFORE the extension so its SW connects on first attempt.
  mock = await startMockAppWsServer();

  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    args: ['--headless=new', `--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`],
  });
  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extensionId = worker.url().split('/')[2];

  extPage = await context.newPage();
  await extPage.goto(`chrome-extension://${extensionId}/app.html`);
});

test.afterAll(async () => {
  await context?.close();
  await mock?.close();
});

test('the SW connects to the dig-app identity channel', async () => {
  await expect
    .poll(async () => (await swSend<{ data?: { connState?: string } }>(extPage, { action: 'appSignStatus' })).data?.connState, {
      timeout: 15_000,
    })
    .toBe('connected');
});

test('pair → connect → sign round-trips over the paired channel', async () => {
  const paired = await swSend<{ ok: boolean }>(extPage, { action: 'appSignPair' });
  expect(paired.ok).toBe(true);

  const status = await swSend<{ data?: { paired?: boolean } }>(extPage, { action: 'appSignStatus' });
  expect(status.data?.paired).toBe(true);

  const connected = await swSend<{ ok: boolean; data?: { granted?: boolean } }>(extPage, {
    action: 'appSignConnect',
    params: { dappName: 'e2e' },
  });
  expect(connected.ok).toBe(true);
  expect(connected.data?.granted).toBe(true);

  const signed = await swSend<{ ok: boolean; data?: { signature_b64?: string } }>(extPage, {
    action: 'appSignSign',
    params: { payloadType: 'spend', payloadB64: 'ZGVhZGJlZWY=' },
  });
  expect(signed.ok).toBe(true);
  expect(signed.data?.signature_b64).toBeTruthy();
});

test('true-origin passthrough: a page-supplied origin is IGNORED; the committed sender origin is relayed', async () => {
  const spoofed = 'https://evil.example';
  await swSend(extPage, { action: 'appSignConnect', params: { origin: spoofed, dappName: 'spoof' } });

  // The mock recorded the origin each connect frame carried; the LAST connect must be the committed
  // extension origin (this page's origin), never the page-supplied spoof.
  const connectFrames = mock.observed.filter((f) => f.method === 'connect.request');
  const last = connectFrames[connectFrames.length - 1];
  expect(last.origin).toBe(`chrome-extension://${extensionId}`);
  expect(last.origin).not.toBe(spoofed);
});
