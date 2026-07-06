import { test, expect, chromium, type BrowserContext, type Worker, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * END-USER e2e for #118 — the extension is a pure `window.chia` injector with NO WalletConnect.
 *
 * It proves, against the BUILT unpacked extension in a real browser:
 *  1. **No WC path ships** — the packaged `dist/` carries no vendored WalletConnect SignClient, the
 *     manifest CSP `connect-src` has no `*.walletconnect.*` relay, and the web-accessible resources
 *     list no WC vendor file. (String scans of the bundles are intentionally avoided: the shared
 *     `@dignetwork/chia-provider` identity carries `transport:'walletconnect'` — #119 — and the SW
 *     source comments name WalletConnect to explain its ABSENCE.)
 *  2. **`window.chia` connect still works** — a real dApp page's injected provider connects and
 *     receives the wallet address straight from the offscreen self-custody vault (no external wallet).
 *  3. **`window.chia` sign still works** — a `chip0002_signMessage` is approval-gated, driven through
 *     the SW approval queue, and the offscreen vault returns a signature. Message signing needs NO
 *     chain and NO funds, so this is fully deterministic in CI.
 *
 * Run: `npm run build && npm run test:sw`.
 */

const EXT_PATH = resolve(process.cwd(), 'dist');
const GOLDEN = JSON.parse(readFileSync(resolve(process.cwd(), 'src/lib/keystore/derive.golden.json'), 'utf8')) as {
  mnemonic: string;
};

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let extensionId: string;
let worker: Worker;
let server: Server;
let dappOrigin: string;

function startDappServer(): Promise<Server> {
  return new Promise((res) => {
    const s = createServer((_req, reply) => {
      reply.writeHead(200, { 'content-type': 'text/html' });
      reply.end('<!doctype html><html><head><title>Test dApp</title></head><body><h1>DIG test dApp</h1></body></html>');
    });
    s.listen(0, '127.0.0.1', () => res(s));
  });
}

/** Send a chrome.runtime message from an extension page and resolve its reply. */
function swSend<T>(page: Page, message: Record<string, unknown>): Promise<T> {
  return page.evaluate(
    (msg) => new Promise<T>((res) => chrome.runtime.sendMessage(msg, res as (r: unknown) => void)),
    message,
  );
}

/** Call window.chia.request in the dApp page; return a discriminated ok/err result. */
function dappRequest(page: Page, method: string, params: Record<string, unknown> = {}) {
  return page.evaluate(
    async ({ method, params }) => {
      const chia = (window as unknown as { chia?: { request: (a: unknown) => Promise<unknown> } }).chia;
      if (!chia) return { ok: false as const, error: 'no window.chia' };
      try {
        return { ok: true as const, data: await chia.request({ method, params }) };
      } catch (e) {
        return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
      }
    },
    { method, params },
  );
}

test.beforeAll(async () => {
  if (!existsSync(resolve(EXT_PATH, 'manifest.json'))) {
    throw new Error(`Built extension not found at ${EXT_PATH} — run \`npm run build\` before the e2e.`);
  }
  server = await startDappServer();
  const { port } = server.address() as AddressInfo;
  dappOrigin = `http://127.0.0.1:${port}`;

  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    args: ['--headless=new', `--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`],
  });
  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extensionId = worker.url().split('/')[2];
});

test.afterAll(async () => {
  await context?.close();
  await new Promise<void>((res) => server?.close(() => res()));
});

test('the built extension ships NO WalletConnect path', () => {
  // No vendored WalletConnect SignClient / legacy popup WC bundle in the package.
  expect(existsSync(resolve(EXT_PATH, 'vendor', 'walletconnect-sign-client.js'))).toBe(false);
  expect(existsSync(resolve(EXT_PATH, 'vendor'))).toBe(false);
  expect(existsSync(resolve(EXT_PATH, 'wallet-wc.js'))).toBe(false);

  const manifest = JSON.parse(readFileSync(resolve(EXT_PATH, 'manifest.json'), 'utf8'));
  // No WalletConnect relay in the CSP egress allow-list.
  expect(manifest.content_security_policy.extension_pages).not.toMatch(/walletconnect/i);
  // No WC vendor file exposed to pages.
  expect(JSON.stringify(manifest.web_accessible_resources)).not.toMatch(/walletconnect/i);
});

test('window.chia connect + sign work with NO WalletConnect (self-custody vault)', async () => {
  const ext = await context.newPage();
  await ext.goto(`chrome-extension://${extensionId}/popup.html`);

  // Set up the self-custody wallet (import the deterministic golden phrase) — unlocks the vault.
  const imported = await swSend<{ lockState?: string; success?: boolean }>(ext, {
    action: 'importWallet',
    mnemonic: GOLDEN.mnemonic,
    password: 'e2e-118-not-a-real-secret',
  });
  expect(imported.success).not.toBe(false);
  expect(imported.lockState).toBe('unlocked');

  // A real dApp page — the <all_urls> content script injects window.chia here.
  const dapp = await context.newPage();
  await dapp.goto(`${dappOrigin}/`);
  await dapp.waitForFunction(() => !!(window as unknown as { chia?: unknown }).chia, undefined, { timeout: 15_000 });

  // The user approves the connection out-of-band (exactly what the popup's Connect prompt does).
  const consent = await swSend<{ success?: boolean }>(ext, { action: 'walletConsent', origin: dappOrigin, approved: true });
  expect(consent.success).not.toBe(false);

  // CONNECT — served by the offscreen self-custody vault (no WalletConnect). Per the CHIP-0002
  // contract, connect resolves a boolean; the address is read separately (getAddress below).
  const conn = await dappRequest(dapp, 'chip0002_connect');
  expect(conn.ok, `connect failed: ${conn.ok ? '' : conn.error}`).toBe(true);
  expect(conn.data).toBe(true);

  // READ — getAddress returns the wallet's receive address from the vault (no WalletConnect).
  const addr = await dappRequest(dapp, 'chia_getAddress');
  expect(addr.ok).toBe(true);
  const address = typeof addr.data === 'string' ? addr.data : (addr.data as { address?: string }).address;
  expect(address).toMatch(/^xch1/);

  // READ — getPublicKeys is served from the vault (no approval, no chain).
  const pks = await dappRequest(dapp, 'chip0002_getPublicKeys');
  expect(pks.ok).toBe(true);
  const publicKey = (pks.data as string[])[0];
  expect(typeof publicKey).toBe('string');

  // SIGN — chip0002_signMessage is approval-gated. Start it (stays pending), drive the SW approval
  // queue to approve it, then the offscreen vault signs and the dApp promise resolves. No funds.
  const signResultP = dappRequest(dapp, 'chip0002_signMessage', { message: 'DIG #118 e2e', publicKey });

  let pendingId = '';
  await expect
    .poll(
      async () => {
        const list = await swSend<{ requests?: { id: string }[] }>(ext, { action: 'dappApprovalList' });
        pendingId = list.requests?.[0]?.id ?? '';
        return list.requests?.length ?? 0;
      },
      { timeout: 15_000 },
    )
    .toBeGreaterThan(0);

  const resolved = await swSend<{ success?: boolean }>(ext, { action: 'dappApprovalResolve', id: pendingId, approved: true });
  expect(resolved.success).toBe(true);

  const signed = await signResultP;
  expect(signed.ok, `sign failed: ${signed.ok ? '' : signed.error}`).toBe(true);
  const signature = (signed.data as { signature?: string }).signature;
  expect(typeof signature).toBe('string');
  expect(signature!.length).toBeGreaterThan(0);

  await dapp.close();
  await ext.close();
});
