import { test, expect, chromium, type BrowserContext, type Worker, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import type { Socket } from 'node:net';
import type { AddressInfo } from 'node:net';

/**
 * END-USER e2e for the dig-node CONTROL PANEL (#278/#281 + the #239 live-status client), against
 * the BUILT unpacked extension in a real browser driving a REAL loopback node that speaks the new
 * wire surface: a WebSocket `/ws/status`, the OPEN `cache.*` (LRU) family, and the `pairing.*` +
 * token-gated `control.*` flow. Proves the four acceptance items:
 *   (a) set reserved cap → applied on the node;
 *   (b) evict a single cached capsule + clear all;
 *   (c) pair (request → operator approves → poll) → the scoped token drives a `control.*` mutation;
 *   (d) node stop/start → the live-status indicator flips Offline→Connected with no user action.
 *
 * Run: `npm run build && npm run test:sw`.
 */

const EXT_PATH = resolve(process.cwd(), 'dist');
const LOOPBACK_IP = '127.0.0.5';
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const PAIRED_TOKEN = 'a'.repeat(64);

/** Mutable node state the fake serves + records, so the test can assert real effects. */
interface FakeState {
  capBytes: number;
  cached: { store_id: string; root: string; size_bytes: number; last_used_unix_ms: number; lru_rank: number }[];
  cleared: boolean;
  pollCount: number;
  upstream: string;
  setUpstreamAuthorized: boolean;
}

function freshState(): FakeState {
  return {
    capBytes: 256 * 1024 * 1024,
    cached: [
      { store_id: 'a'.repeat(64), root: '1'.repeat(64), size_bytes: 2048, last_used_unix_ms: 1000, lru_rank: 0 },
      { store_id: 'b'.repeat(64), root: '2'.repeat(64), size_bytes: 4096, last_used_unix_ms: 2000, lru_rank: 1 },
    ],
    cleared: false,
    pollCount: 0,
    upstream: 'https://rpc.dig.net/',
    setUpstreamAuthorized: false,
  };
}

/** Encode a server→client text frame (RFC6455, unmasked). Handles <126 and 16-bit lengths. */
function wsTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else {
    header = Buffer.from([0x81, 126, (len >> 8) & 0xff, len & 0xff]);
  }
  return Buffer.concat([header, payload]);
}

function statusFrame(state: FakeState, type: 'status' | 'heartbeat'): string {
  return JSON.stringify({
    type,
    service: 'dig-node',
    version: '0.12.0',
    commit: 'e2e',
    mode: 'local-node',
    addr: `${LOOPBACK_IP}:0`,
    upstream: state.upstream,
    cache: { dir: '/tmp', cap_bytes: state.capBytes, used_bytes: 6144, shared: true },
    sync: { available: true },
    ...(type === 'heartbeat' ? { ts: Date.now() } : {}),
  });
}

/** A real loopback node speaking the control-panel wire surface (HTTP + WS), bound to a fixed port. */
function startFakeNode(state: FakeState, port: number): Promise<Server> {
  const wsSockets = new Set<Socket>();
  return new Promise((resolvePromise, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
        return;
      }
      if (req.method === 'POST') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          let parsed: { id?: number; method?: string; params?: Record<string, unknown> } = {};
          try { parsed = JSON.parse(body); } catch { /* tolerate */ }
          const id = parsed.id ?? 1;
          const token = req.headers['x-dig-control-token'];
          const ok = (result: unknown) => JSON.stringify({ jsonrpc: '2.0', id, result });
          const err = (code: number, message: string) =>
            JSON.stringify({ jsonrpc: '2.0', id, error: { code, message, data: { code: 'UNAUTHORIZED' } } });
          let out: string;
          switch (parsed.method) {
            case 'cache.getConfig':
              out = ok({ cap_bytes: state.capBytes, used_bytes: 6144, cache_dir: '/tmp', shared: true });
              break;
            case 'cache.stats':
              out = ok({ cap_bytes: state.capBytes, used_bytes: 6144, entry_count: state.cached.length, total_bytes: 6144, evicted_count: 0, evicted_bytes: 0, content_cache: { hits: 0, misses: 0 } });
              break;
            case 'cache.listCached':
              out = ok({ cached: state.cleared ? [] : state.cached });
              break;
            case 'cache.setCapBytes':
              state.capBytes = Math.max(64 * 1024 * 1024, Number(parsed.params?.cap_bytes) || 0);
              out = ok({ cap_bytes: state.capBytes });
              break;
            case 'cache.removeCached': {
              const before = state.cached.length;
              state.cached = state.cached.filter((c) => c.store_id !== parsed.params?.store_id);
              out = ok({ removed: state.cached.length !== before });
              break;
            }
            case 'cache.clear':
              state.cleared = true;
              state.cached = [];
              out = ok({});
              break;
            case 'pairing.request':
              out = ok({ pairing_id: 'pid-e2e', pairing_code: '481920', expires_ms: Date.now() + 60_000 });
              break;
            case 'pairing.poll':
              state.pollCount += 1;
              // Simulate the operator approving after the first poll (compare-codes step).
              out = state.pollCount >= 2
                ? ok({ status: 'approved', token: PAIRED_TOKEN })
                : ok({ status: 'pending' });
              break;
            case 'control.config.setUpstream':
              if (token === PAIRED_TOKEN) {
                state.upstream = String(parsed.params?.upstream ?? '');
                state.setUpstreamAuthorized = true;
                out = ok({ upstream: state.upstream, requires_restart: true });
              } else {
                out = err(-32030, 'unauthorized');
              }
              break;
            case 'control.config.get':
              out = token === PAIRED_TOKEN ? ok({ upstream: state.upstream }) : err(-32030, 'unauthorized');
              break;
            case 'control.hostedStores.list':
              out = token === PAIRED_TOKEN ? ok({ stores: [] }) : err(-32030, 'unauthorized');
              break;
            case 'control.sync.status':
              out = token === PAIRED_TOKEN ? ok({ available: true, pinned_total: 0, pinned_synced: 0 }) : err(-32030, 'unauthorized');
              break;
            case 'control.peerStatus':
              out = token === PAIRED_TOKEN ? ok({ running: false, connected_peers: 0 }) : err(-32030, 'unauthorized');
              break;
            default:
              out = JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } });
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(out);
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });

    // WebSocket upgrade for /ws/status — hand-rolled RFC6455 (no `ws` dep): handshake, an initial
    // status frame, then heartbeats. The open socket IS the liveness signal the SW consumes.
    server.on('upgrade', (req, socket: Socket) => {
      if (!req.url || !req.url.startsWith('/ws/status')) {
        socket.destroy();
        return;
      }
      const key = req.headers['sec-websocket-key'] as string;
      const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
          'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      wsSockets.add(socket);
      socket.write(wsTextFrame(statusFrame(state, 'status')));
      const hb = setInterval(() => {
        try { socket.write(wsTextFrame(statusFrame(state, 'heartbeat'))); } catch { /* closed */ }
      }, 1000);
      const cleanup = () => { clearInterval(hb); wsSockets.delete(socket); };
      socket.on('close', cleanup);
      socket.on('error', cleanup);
      socket.on('data', () => { /* drain client frames (pong/close) */ });
    });

    // Track sockets so close() actually tears down live WS connections promptly (offline flip).
    (server as Server & { _wsSockets?: Set<Socket> })._wsSockets = wsSockets;
    server.on('error', reject);
    server.listen(port, LOOPBACK_IP, () => resolvePromise(server));
  });
}

function stopFakeNode(server: Server | null): Promise<void> {
  return new Promise((res) => {
    if (!server) return res();
    const sockets = (server as Server & { _wsSockets?: Set<Socket> })._wsSockets;
    sockets?.forEach((s) => s.destroy());
    server.close(() => res());
  });
}

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let extensionId: string;
let worker: Worker;

function swSend<T>(page: Page, message: Record<string, unknown>): Promise<T> {
  return page.evaluate((msg) => new Promise<T>((res) => chrome.runtime.sendMessage(msg, res as (r: unknown) => void)), message);
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

test('control panel: live status, cache cap/evict/clear, pairing → control mutation, offline/online flip', async () => {
  const state = freshState();
  // Pick a fixed free port so the node can be stopped + restarted on the SAME endpoint (flip test).
  const probe = await startFakeNode(state, 0);
  const port = (probe.address() as AddressInfo).port;
  await stopFakeNode(probe);
  let server: Server | null = await startFakeNode(state, port);

  try {
    const page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await swSend(page, { action: 'updateServerConfig', host: `${LOOPBACK_IP}:${port}` });

    // Fullscreen panel (wide → all sections render, §6.4 tiering).
    const app = await context.newPage();
    await app.setViewportSize({ width: 1280, height: 900 });
    await app.goto(`chrome-extension://${extensionId}/app.html#network/control`);
    await expect(app.getByTestId('control-panel')).toHaveAttribute('data-mode', 'manage', { timeout: 20_000 });

    // (d1) Live status connects via the WS.
    await expect(app.getByTestId('control-live-pill')).toContainText(/connected/i, { timeout: 20_000 });

    // (a) Set the reserved cap → applied on the node.
    await app.getByTestId('control-cache-cap-input').fill('128');
    await app.getByTestId('control-cache-cap-apply').click();
    await expect.poll(() => state.capBytes, { timeout: 10_000 }).toBe(128 * 1024 * 1024);

    // (b) Evict a single capsule, then clear all.
    await expect(app.getByTestId('control-cache-entry').first()).toBeVisible();
    await app.getByTestId('control-cache-evict').first().click();
    await expect.poll(() => state.cached.length, { timeout: 10_000 }).toBe(1);
    await app.getByTestId('control-cache-clear').click();
    await expect.poll(() => state.cleared, { timeout: 10_000 }).toBe(true);

    // (c) Pair → the operator approves (fake approves on the 2nd poll) → paired → drive a control mutation.
    await app.getByTestId('control-pairing-start').click();
    await expect(app.getByTestId('control-pairing-code')).toContainText('481920', { timeout: 10_000 });
    await expect(app.getByTestId('control-pairing-pill')).toContainText(/paired/i, { timeout: 15_000 });
    await expect(app.getByTestId('control-upstream')).toBeVisible();
    await app.getByTestId('control-upstream-input').fill('https://my.custom.node/');
    await app.getByTestId('control-upstream-set').click();
    await expect.poll(() => state.setUpstreamAuthorized, { timeout: 10_000 }).toBe(true);
    expect(state.upstream).toBe('https://my.custom.node/');

    // Screenshots (§6.5) — fullscreen (paired) + popup (compact).
    await app.screenshot({ path: 'e2e/__screenshots__/control-panel-fullscreen.png', fullPage: true });
    const popup = await context.newPage();
    await popup.setViewportSize({ width: 372, height: 640 });
    await popup.goto(`chrome-extension://${extensionId}/popup.html#network/control`);
    await expect(popup.getByTestId('control-open-full')).toBeVisible({ timeout: 15_000 });
    await popup.screenshot({ path: 'e2e/__screenshots__/control-panel-popup.png' });
    await popup.close();

    // (d2) Stop the node → the live indicator flips to Offline with no user action.
    await stopFakeNode(server);
    server = null;
    await expect(app.getByTestId('control-live-pill')).toContainText(/offline/i, { timeout: 20_000 });

    // (d3) Restart the node on the SAME endpoint → the indicator flips back to Connected automatically.
    server = await startFakeNode(state, port);
    await expect(app.getByTestId('control-live-pill')).toContainText(/connected/i, { timeout: 30_000 });

    await app.close();
    await page.close();
  } finally {
    await stopFakeNode(server);
  }
});
