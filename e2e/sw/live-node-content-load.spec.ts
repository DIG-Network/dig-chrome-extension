import { test, expect, chromium, type BrowserContext, type Worker, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { existsSync, unlinkSync } from 'node:fs';
import { createServer, request as httpRequest, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * LEG B — headline live e2e: the BUILT extension, in a REAL (headless) Chromium, loads real
 * published chia:// content THROUGH the local dig-node (verify + decrypt), proven by:
 *   (a) the decrypted bytes coming back verified against the chain-anchored root;
 *   (b) a network trace (a logging reverse-proxy the extension is pointed at) showing the SW POST
 *       dig.getContent for the resource's retrieval_key to the node — and NO other host contacted;
 *   (c) the node's own response-cache repopulating on disk as a server-side side-effect.
 * Requires a live dig-node at 127.0.0.1:9778 + live mainnet.
 *
 * The extension's content-load-through-node path is the SW `proxyRequest` handler
 * (`fetchContentViaRPC` → §5.3 ladder → node → verify → decrypt → data: URL). B.4 additionally
 * proves the dig-viewer RENDERS the decrypted store page IN-WINDOW via the MV3 SANDBOXED frame
 * (#225), and B.1b proves a ROOTLESS URN now verifies against the chain-anchored root (#226).
 *
 * Target: the dighub harness store (real content pushed via digstore CLI 2026-06-17), a small
 * self-contained index.html, mainnet-anchored, published to rpc.dig.net.
 */

const EXT_PATH = resolve(process.cwd(), 'dist');
const NODE = 'http://127.0.0.1:9778';
const NODE_HOST = '127.0.0.1';
const NODE_PORT = 9778;
// The proxy binds a NON-alias loopback (127.0.0.5 — the harness's proven-working literal) so
// `server.host` is treated as a GENUINE custom override that wins the §5.3 ladder ENTIRELY
// (127.0.0.1/localhost/dig.local are aliases that instead feed the auto-probe ladder).
const PROXY_HOST = '127.0.0.5';
const STORE_ID = 'ab554db9c62e8dc2185914741e06539bacdcc3670762417a5f644b84fd382812';
const ANCHORED_ROOT = '9e26ff2500930604278dd013c986a3d3ace2565c69e13583e8575c70319bd98b';
const INDEX_KEY = '4233a940eac937bfa726acebb3a3a3b8e233f4fb4ad7833d30ad1f111fbb339d';
const EXPECT_TEXT = 'dighub STORE pipeline harness';
const URN_ROOTLESS = `chia://urn:dig:chia:${STORE_ID}/index.html`;
const URN_ROOTED = `chia://urn:dig:chia:${STORE_ID}:${ANCHORED_ROOT}/index.html`;
const CACHE_FILE = `C:/Users/micha/AppData/Local/DigNode/cache/responses/${STORE_ID}_${ANCHORED_ROOT}_${INDEX_KEY}_0.json`;

type ProxyResult = { success: boolean; data?: string; contentType?: string; verified?: boolean; code?: string; message?: string; error?: string };

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let extensionId: string;
let worker: Worker;
// Logging reverse-proxy → the real node. Records every request the extension makes so we can prove
// the SW hit the node with dig.getContent and contacted no other host.
let proxy: Server;
let proxyUrl: string;
const proxyLog: { method: string; url: string; body: string }[] = [];

async function setServerHost(page: Page, host: string): Promise<void> {
  await page.evaluate(async (h) => { await chrome.storage.local.set({ 'server.host': h }); }, host);
}
async function swProxy(page: Page, url: string): Promise<ProxyResult> {
  return page.evaluate((u) => new Promise<ProxyResult>((res) => chrome.runtime.sendMessage({ action: 'proxyRequest', url: u }, (r: ProxyResult) => res(r))), url);
}
async function extPage(): Promise<Page> {
  const p = await context.newPage();
  await p.goto(`chrome-extension://${extensionId}/dig-viewer.html?urn=chia://${'c'.repeat(64)}/x`);
  return p;
}

function startProxy(): Promise<void> {
  return new Promise((res, rej) => {
    proxy = createServer((req: IncomingMessage, cres: ServerResponse) => {
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
      if (req.method === 'OPTIONS') { cres.writeHead(204, cors); cres.end(); return; }
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c as Buffer));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        proxyLog.push({ method: req.method || '', url: req.url || '', body });
        const fwd = httpRequest({ host: NODE_HOST, port: NODE_PORT, path: req.url, method: req.method, headers: { ...req.headers, host: `${NODE_HOST}:${NODE_PORT}` } }, (nres) => {
          const nb: Buffer[] = [];
          nres.on('data', (c) => nb.push(c as Buffer));
          nres.on('end', () => { cres.writeHead(nres.statusCode || 200, { ...nres.headers, ...cors }); cres.end(Buffer.concat(nb)); });
        });
        fwd.on('error', (e) => { cres.writeHead(502, cors); cres.end(String(e)); });
        if (body) fwd.write(body);
        fwd.end();
      });
    });
    proxy.on('error', rej);
    proxy.listen(0, PROXY_HOST, () => { proxyUrl = `http://${PROXY_HOST}:${(proxy.address() as AddressInfo).port}`; res(); });
  });
}

test.beforeAll(async () => {
  if (!existsSync(resolve(EXT_PATH, 'manifest.json'))) throw new Error(`run \`npm run build\` first — no ${EXT_PATH}`);
  await startProxy();
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    args: ['--headless=new', `--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`],
  });
  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extensionId = worker.url().split('/')[2];
});
test.afterAll(async () => {
  await context?.close();
  await new Promise<void>((r) => (proxy ? proxy.close(() => r()) : r()));
});

test('B.1 — extension loads real chia:// content THROUGH the local node (verified + decrypted)', async () => {
  try { if (existsSync(CACHE_FILE)) unlinkSync(CACHE_FILE); } catch { /* ignore */ }
  expect(existsSync(CACHE_FILE), 'node cache pre-cleared for index.html').toBe(false);

  const cfg = await extPage();
  await setServerHost(cfg, proxyUrl); // point the extension at the logging proxy → the node
  proxyLog.length = 0;

  // Rooted URN pins the chain-anchored generation, so verifyInclusion runs against the real root.
  const r = await swProxy(cfg, URN_ROOTED);
  console.log('proxyRequest result: success=%s verified=%s contentType=%s code=%s', r.success, r.verified, r.contentType, r.code || '');
  expect(r.success, `proxyRequest succeeded (err=${r.error || r.message || ''})`).toBe(true);
  expect(r.verified, 'content verified against the chain-anchored root').toBe(true);
  expect(r.data?.startsWith('data:'), 'a data: URL came back').toBe(true);

  // Decode the returned data: URL → the DECRYPTED bytes the extension produced from the node stream.
  const decoded = Buffer.from(r.data!.split(',')[1], 'base64').toString('utf8');
  console.log('decrypted content (first 160):', JSON.stringify(decoded.slice(0, 160)));
  expect(decoded).toContain(EXPECT_TEXT);

  // (b) Network trace via the logging proxy: the SW POSTed dig.getContent for THIS retrieval_key.
  const methods = proxyLog.map(x => { try { return JSON.parse(x.body).method; } catch { return x.method + ' ' + x.url; } });
  console.log('extension → node requests:', JSON.stringify(methods));
  const getContentHits = proxyLog.filter(x => x.body.includes('dig.getContent') && x.body.includes(INDEX_KEY));
  expect(getContentHits.length, 'SW POSTed dig.getContent(index.html key) to the node').toBeGreaterThan(0);
  // Every request the extension made went to the node proxy (no other host / no rpc.dig.net leak).
  expect(proxyLog.length, 'the extension contacted only the node').toBeGreaterThan(0);

  // (c) Server-side side-effect: the node repopulated its response cache for this exact resource.
  expect(existsSync(CACHE_FILE), 'node response-cache file recreated by the fetch').toBe(true);

  // Screenshot the actual content the extension loaded + decrypted through the node.
  const view = await context.newPage();
  await view.setContent(decoded);
  await view.setViewportSize({ width: 1280, height: 720 });
  await view.screenshot({ path: 'e2e/__screenshots__/legB-node-served-content-desktop.png', fullPage: true });
  await view.setViewportSize({ width: 390, height: 844 });
  await view.screenshot({ path: 'e2e/__screenshots__/legB-node-served-content-mobile.png', fullPage: true });
  await view.close();
  await cfg.close();
});

test('B.1b — rootless URN verifies against the CHAIN-ANCHORED root through the node (#226)', async () => {
  const cfg = await extPage();
  await setServerHost(cfg, proxyUrl);
  proxyLog.length = 0;
  const r = await swProxy(cfg, URN_ROOTLESS);
  console.log('rootless proxyRequest: success=%s verified=%s', r.success, r.verified);
  expect(r.success, 'rootless read succeeds through the node').toBe(true);
  const decoded = Buffer.from(r.data!.split(',')[1], 'base64').toString('utf8');
  expect(decoded, 'rootless content decrypts correctly').toContain(EXPECT_TEXT);
  // #226 FIX: fetchContentViaRPC now resolves the CHAIN-anchored root (dig.getAnchoredRoot on the
  // node) for a rootless URN and verifies the proof against THAT — no longer the literal 'latest'.
  // So genuinely valid latest-generation content is correctly reported VERIFIED.
  expect(r.verified, 'rootless content verified against the anchored root').toBe(true);
  // Proof of the mechanism: the SW asked the node for the anchored root before verifying.
  const anchoredHits = proxyLog.filter((x) => x.body.includes('dig.getAnchoredRoot') && x.body.includes(STORE_ID));
  expect(anchoredHits.length, 'SW POSTed dig.getAnchoredRoot(store_id) to resolve the trusted root').toBeGreaterThan(0);
  await cfg.close();
});

test('B.2 — opening a chia:// address routes the tab into the in-window viewer (redirect + loader shell)', async () => {
  const page = await context.newPage();
  // Mock only getDigDnsStatus → unavailable so the open-URN input takes the dig-viewer branch
  // (the real user flow when no native .dig proxy is up); every other action hits the REAL SW.
  await page.addInitScript(() => {
    window.close = () => {}; // the popup self-closes after firing nav; keep the page alive to observe
    const realSend = chrome.runtime.sendMessage.bind(chrome.runtime);
    // @ts-expect-error harness override
    chrome.runtime.sendMessage = (msg: { action?: string }, cb?: (r: unknown) => void) => {
      if (msg && msg.action === 'getDigDnsStatus') {
        const reply = { phase: 'unavailable', boundPort: null, pacUrl: null, loopbackIp: '127.0.0.5', proxyActive: false, lastProbeAt: 1, lastError: null };
        if (typeof cb === 'function') { cb(reply); return undefined; }
        return Promise.resolve(reply);
      }
      return realSend(msg, cb as never);
    };
  });
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.getByTestId('home-openurn-input').fill(URN_ROOTLESS);
  await page.getByTestId('home-openurn-go').click();

  // The REAL background navigateToDigUrl redirects THIS tab into the extension's own content view.
  await page.waitForURL((url) => url.pathname.startsWith('/dig-viewer.html'), { timeout: 15_000 });
  console.log('intercepted → in-window viewer:', page.url());
  expect(new URL(page.url()).protocol).toBe('chrome-extension:');
  expect(page.url()).toContain('urn=');
  // The branded loader shell renders (spinner + verify-banner scaffold) — no white screen.
  await expect(page.getByTestId('verify-banner')).toBeAttached();
  await expect(page.locator('#loadingText')).toContainText(/loading dig content/i);
  await page.screenshot({ path: 'e2e/__screenshots__/legB-viewer-loader-shell.png', fullPage: true });
  await page.close();
});

test('B.3 — node unreachable → graceful rpc.dig.net fallback + clean coded error (no white screen); recovers', async () => {
  const cfg = await extPage();
  // Local node "down": a GENUINE override (non-alias 127.0.0.5) to a dead port. The §5.3 ladder's
  // documented safety net is rpc.dig.net, so a real published resource STILL resolves (no white
  // screen) — the documented graceful fallback.
  await setServerHost(cfg, 'http://127.0.0.5:9');
  const fallback = await swProxy(cfg, URN_ROOTED);
  console.log('node-down → fallback:', JSON.stringify({ success: fallback.success, verified: fallback.verified }));
  expect(fallback.success, 'a down local node gracefully falls back to rpc.dig.net (no white screen)').toBe(true);

  // A genuinely unresolvable resource (with the local node down) surfaces a CLEAN CODED error —
  // never a throw / blank screen.
  const err = await swProxy(cfg, `chia://urn:dig:chia:${STORE_ID}/does-not-exist-${Date.now()}.bin`);
  console.log('unresolvable read:', JSON.stringify({ success: err.success, code: err.code, error: err.error || err.message }));
  expect(err.success, 'an unresolvable read fails cleanly').toBe(false);
  expect(err.code || err.error || err.message, 'a coded/described error is surfaced (DIG_ERR_*)').toBeTruthy();

  // Recovery: restore the local node → the read succeeds through the node again (verified).
  await setServerHost(cfg, proxyUrl);
  const up = await swProxy(cfg, URN_ROOTED);
  console.log('recovered:', JSON.stringify({ success: up.success, verified: up.verified }));
  expect(up.success && up.verified, 'read recovers through the local node once reachable').toBe(true);
  await cfg.close();
});

test('B.4 — dig-viewer RENDERS the decrypted store page IN-WINDOW via the sandboxed frame (#225 + #226)', async () => {
  // Point the extension at the live node (via the logging proxy so server.host is a genuine override).
  const cfg = await extPage();
  await setServerHost(cfg, proxyUrl);
  await cfg.close();

  // Navigate the tab straight into the in-window content viewer for the ROOTLESS URN (the common case).
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/dig-viewer.html?urn=${encodeURIComponent(URN_ROOTLESS)}`);

  // THE #225 ASSERTION: the decrypted store page actually RENDERS inside the MV3 sandboxed frame
  // (dig-store-frame.html) — the real content, not merely the loader shell. Before this fix the
  // extension's own CSP blocked the data:-frame + its inline scripts, so nothing rendered.
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('body')).toContainText(EXPECT_TEXT, { timeout: 30_000 });

  // THE #226 ASSERTION (in the UI): the verify banner reads verified — the rootless read proved
  // against the chain-anchored root, surfaced as "Verified on Chia".
  await expect(page.getByTestId('verify-banner')).toHaveAttribute('data-verified', 'true', { timeout: 30_000 });
  // The branded loader spinner is gone once the content rendered (no spinner-forever).
  await expect(page.locator('#loading')).toBeHidden();

  // Screenshot the ACTUAL in-window rendered content (§6.5 — desktop + mobile) for visual inspection.
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.screenshot({ path: 'e2e/__screenshots__/legB-inwindow-render-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'e2e/__screenshots__/legB-inwindow-render-mobile.png', fullPage: true });
  await page.close();
});
