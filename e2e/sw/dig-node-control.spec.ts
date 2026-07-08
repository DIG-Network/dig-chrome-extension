import { test, expect, chromium, type BrowserContext, type Worker, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * END-USER e2e for #129 (dig-node required messaging) + #130 (control-surface parity) — proves,
 * against the BUILT unpacked extension in a real browser, BOTH detection states the Control tab
 * (`#network/control`) must render honestly, and drives the control.* wire contract over a REAL
 * loopback HTTP server (not a mocked `fetch`) standing in for a dig-node — the same "real socket,
 * no mocking" bar `e2e/sw/dig-dns-proxy-fallback.spec.ts` set for the sibling dig-dns detector:
 *
 *   1. **No local dig-node reachable** (nothing listening, default ladder) → `getDigNodeStatus`/
 *      `getControlStatus` report `install` honestly, and the Control tab renders the "Install the
 *      dig-node for the full experience" CTA — never a stuck spinner or a false "online" claim.
 *   2. **A real node answering `control.status` in the OPEN surface** (no auth) → `manage` mode
 *      with live stats rendered straight from the wire response.
 *   3. **A real node answering `control.status` with the canonical `-32030 UNAUTHORIZED`** (the
 *      expected reply for a token-less MV3 extension, per the dig-node control contract reconciled
 *      in #130 / dig-node SPEC.md §6-10) → still `manage` (a node IS present), but honestly with no
 *      live stats and the "full management needs the DIG Browser" note — never misreported as a
 *      transient error or downgraded to `install`.
 *
 * Cases 2+3 point `server.host` at the {@link LOOPBACK_IP} fake node, so they ALSO exercise the
 * §5.3 CUSTOM-node-OVERRIDE tier: a configured non-alias host is probed verbatim and drives
 * control (the ladder's alias tiers `dig.local`/`localhost` are unit-tested in
 * `src/lib/dig-node-resolve.test.ts`; case 1 here covers the ladder returning "none reachable").
 *
 * This is the closest live-wire proof achievable inside this repo without a cross-repo dig-node
 * Rust build: the fake server speaks the EXACT canonical contract (JSON-RPC POST /, `control.status`,
 * the `-32030` code) byte-for-byte per `src/lib/dig-control.ts`, so a one-sided drift in either the
 * extension or a future literal dig-node-binary harness would fail this test. A full "spin up the
 * actual dig-node OS-service binary" integration pass is a separate, cross-repo follow-up (needs a
 * dig-node build artifact / launch harness) — out of scope for this extension-only lane.
 *
 * Also captures the popup + fullscreen screenshots for both detection states (§6.5) so the
 * "no node" and "node present" renders can be visually inspected for spacing/rhythm regressions.
 *
 * Run: `npm run build && npm run test:sw`.
 */

const EXT_PATH = resolve(process.cwd(), 'dist');
/**
 * Bind the fake node to an explicit IPv4 loopback LITERAL (not `localhost`, not `127.0.0.1`):
 *  - `127.0.0.5` is in the extension's `host_permissions` (same address the dig-dns e2e uses), so
 *    the SW is allowed to reach it.
 *  - It is NOT one of the §5.3 local aliases (`localhost`/`127.0.0.1`/`::1`/`dig.local`), so
 *    configuring it as `server.host` exercises the CUSTOM-node-OVERRIDE tier: the ladder probes
 *    the literal `http://127.0.0.5:<port>` VERBATIM (it does not rewrite to `localhost:<port>`).
 *  - An IPv4 literal sidesteps the `localhost`→`::1`-first resolution that makes an IPv4-only
 *    Node server look unreachable to the browser (the bug that sank the first `127.0.0.1` cut).
 */
const LOOPBACK_IP = '127.0.0.5';
/** The canonical control-plane UNAUTHORIZED code (src/lib/dig-control.ts `CONTROL_ERR.UNAUTHORIZED`). */
const UNAUTHORIZED_CODE = -32030;
/** Canned `control.status` payload the "open" fake node answers with. */
const OPEN_STATUS = {
  hosted_store_count: 3,
  cached_capsule_count: 7,
  cache: { used_bytes: 123_456 },
  sync: { available: true },
  upstream: 'https://rpc.dig.net/',
};

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let extensionId: string;
let worker: Worker;

function swSend<T>(page: Page, message: Record<string, unknown>): Promise<T> {
  return page.evaluate((msg) => new Promise<T>((res) => chrome.runtime.sendMessage(msg, res as (r: unknown) => void)), message);
}

/** Point the extension's dig-node ladder at a custom host and wait for the write to land. */
async function setServerHost(page: Page, host: string): Promise<void> {
  await swSend(page, { action: 'updateServerConfig', host });
}

/**
 * A tiny REAL loopback HTTP server speaking the dig-node control wire contract: any GET (incl. the
 * `no-cors` reachability probe) answers 200, and `POST /` answers the JSON-RPC envelope for
 * `control.status` per `mode` — `'open'` returns the live stats, `'gated'` returns the canonical
 * `-32030 UNAUTHORIZED` (HTTP 200 — JSON-RPC errors are NOT HTTP errors, `controlRpc` only maps a
 * non-2xx status to a synthetic `-32000`).
 */
function startFakeDigNode(mode: 'open' | 'gated'): Promise<{ server: Server; port: number }> {
  return new Promise((resolvePromise, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
        return;
      }
      if (req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          let parsed: { id?: number; method?: string } = {};
          try { parsed = JSON.parse(body); } catch { /* tolerate malformed bodies in tests */ }
          const envelope =
            mode === 'open'
              ? { jsonrpc: '2.0', id: parsed.id ?? 1, result: OPEN_STATUS }
              : { jsonrpc: '2.0', id: parsed.id ?? 1, error: { code: UNAUTHORIZED_CODE, message: 'unauthorized: missing control token' } };
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(envelope));
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.on('error', reject);
    server.listen(0, LOOPBACK_IP, () => resolvePromise({ server, port: (server.address() as AddressInfo).port }));
  });
}

function stopFakeDigNode(server: Server | null | undefined): Promise<void> {
  return new Promise((res) => (server ? server.close(() => res()) : res()));
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

test('no local dig-node reachable — honest "install" state, never a false online claim', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html#network/control`);

  const nodeStatus = await swSend<{ reachable?: boolean; base?: string | null }>(page, { action: 'getDigNodeStatus' });
  expect(nodeStatus.reachable).toBe(false);
  expect(nodeStatus.base).toBeNull();

  const control = await swSend<{ mode?: string; localNode?: boolean; authRequired?: boolean; status?: unknown }>(page, {
    action: 'getControlStatus',
  });
  expect(control.mode).toBe('install');
  expect(control.localNode).toBe(false);
  expect(control.status).toBeNull();

  await expect(page.getByTestId('control-panel')).toHaveAttribute('data-mode', 'install');
  await expect(page.getByTestId('control-install-note')).toBeVisible();
  await expect(page.getByTestId('control-install-note')).toContainText(/install(ed)? and running/i);
  const installCta = page.getByTestId('control-install');
  await expect(installCta).toBeVisible();
  await expect(installCta).toHaveAttribute('href', /dig-installer\/releases/);
  // Honest even without a node: reads keep working via the hosted gateway.
  await expect(page.getByTestId('control-read-fallback')).toContainText(/rpc\.dig\.net/i);

  await page.setViewportSize({ width: 372, height: 640 });
  await page.waitForTimeout(150);
  await page.screenshot({ path: 'e2e/__screenshots__/dig-node-control-install-popup.png' });

  const fullscreen = await context.newPage();
  await fullscreen.setViewportSize({ width: 1200, height: 860 });
  await fullscreen.goto(`chrome-extension://${extensionId}/app.html#network/control`);
  await expect(fullscreen.getByTestId('control-panel')).toHaveAttribute('data-mode', 'install');
  await fullscreen.waitForTimeout(150);
  await fullscreen.screenshot({ path: 'e2e/__screenshots__/dig-node-control-install-fullscreen.png' });

  await fullscreen.close();
  await page.close();
});

test('a real OPEN dig-node (no token gate) — manage mode with LIVE stats from the wire', async () => {
  const { server, port } = await startFakeDigNode('open');
  try {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html#network/control`);
    await setServerHost(page, `${LOOPBACK_IP}:${port}`);

    await expect
      .poll(async () => (await swSend<{ reachable?: boolean }>(page, { action: 'getDigNodeStatus' })).reachable, {
        timeout: 15_000,
        message: 'the fake open dig-node was never detected reachable',
      })
      .toBe(true);

    const nodeStatus = await swSend<{ base?: string | null }>(page, { action: 'getDigNodeStatus' });
    expect(nodeStatus.base).toBe(`http://${LOOPBACK_IP}:${port}`);

    const control = await swSend<{
      mode?: string; localNode?: boolean; authRequired?: boolean; controlEndpoint?: string | null;
      status?: { hosted_store_count?: number; cached_capsule_count?: number } | null;
    }>(page, { action: 'getControlStatus' });
    expect(control.mode).toBe('manage');
    expect(control.localNode).toBe(true);
    expect(control.authRequired).toBe(false);
    expect(control.controlEndpoint).toBe(`http://${LOOPBACK_IP}:${port}/`);
    expect(control.status?.hosted_store_count).toBe(OPEN_STATUS.hosted_store_count);
    expect(control.status?.cached_capsule_count).toBe(OPEN_STATUS.cached_capsule_count);

    await page.reload();
    await page.waitForURL(/#network\/control/);
    await expect(page.getByTestId('control-panel')).toHaveAttribute('data-mode', 'manage');
    await expect(page.getByTestId('control-node-state')).toContainText(/running/i);
    await expect(page.getByTestId('control-stats')).toContainText(String(OPEN_STATUS.hosted_store_count));
    await expect(page.getByTestId('control-manage-note')).toBeVisible();
    await expect(page.getByTestId('control-get-browser')).toBeVisible();
    await expect(page.getByTestId('control-read-fallback')).toContainText(/locally/i);

    await page.setViewportSize({ width: 372, height: 640 });
    await page.waitForTimeout(150);
    await page.screenshot({ path: 'e2e/__screenshots__/dig-node-control-manage-open-popup.png' });

    const fullscreen = await context.newPage();
    await fullscreen.setViewportSize({ width: 1200, height: 860 });
    await fullscreen.goto(`chrome-extension://${extensionId}/app.html#network/control`);
    await expect(fullscreen.getByTestId('control-panel')).toHaveAttribute('data-mode', 'manage');
    await fullscreen.waitForTimeout(150);
    await fullscreen.screenshot({ path: 'e2e/__screenshots__/dig-node-control-manage-open-fullscreen.png' });

    await fullscreen.close();
    await page.close();
  } finally {
    await stopFakeDigNode(server);
  }
});

test('a real TOKEN-GATED dig-node (-32030 UNAUTHORIZED) — still "manage" (node present), never a false error/absent state', async () => {
  const { server, port } = await startFakeDigNode('gated');
  try {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html#network/control`);
    await setServerHost(page, `${LOOPBACK_IP}:${port}`);

    await expect
      .poll(async () => (await swSend<{ reachable?: boolean }>(page, { action: 'getDigNodeStatus' })).reachable, {
        timeout: 15_000,
        message: 'the fake gated dig-node was never detected reachable',
      })
      .toBe(true);

    const control = await swSend<{ mode?: string; localNode?: boolean; authRequired?: boolean; status?: unknown }>(page, {
      action: 'getControlStatus',
    });
    // The node IS present and answering — UNAUTHORIZED on the mutating surface must never be
    // misclassified as "no node" (install) or a generic transient error.
    expect(control.mode).toBe('manage');
    expect(control.localNode).toBe(true);
    expect(control.authRequired).toBe(true);
    expect(control.status).toBeNull();

    await page.reload();
    await page.waitForURL(/#network\/control/);
    await expect(page.getByTestId('control-panel')).toHaveAttribute('data-mode', 'manage');
    await expect(page.getByTestId('control-node-state')).toContainText(/running/i);
    // No live stats surface when the node only answered UNAUTHORIZED.
    await expect(page.getByTestId('control-stats')).toHaveCount(0);
    await expect(page.getByTestId('control-manage-note')).toContainText(/DIG Browser/i);

    await page.setViewportSize({ width: 372, height: 640 });
    await page.waitForTimeout(150);
    await page.screenshot({ path: 'e2e/__screenshots__/dig-node-control-manage-gated-popup.png' });

    await page.close();
  } finally {
    await stopFakeDigNode(server);
  }
});
