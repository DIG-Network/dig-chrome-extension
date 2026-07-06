import { test, expect, chromium, type BrowserContext, type Worker, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * END-USER e2e for #67 P0-4 (granular revocable permissions + Connected sites) — the standing
 * acceptance bar: load the BUILT unpacked extension in a real browser and exercise the feature
 * end-to-end, proving it works (in ADDITION to the unit/sim tests).
 *
 * It drives the REAL stack against `dist/` (build first):
 *  - a real served dApp page (a genuine http origin) gets the injected `window.chia` provider;
 *  - the dApp CONNECTS (the user approves out-of-band via the popup's walletConsent, exactly as the
 *    real Connect prompt does — the grant is what establishes the connection in the consent store);
 *  - the dApp SEES itself connected via the REAL provider `window.chia.request('wallet_getPermissions')`;
 *  - the site SHOWS UP in Connected-sites (`listConnectedSites`, the settings screen's data source);
 *  - the site is REVOKED (`revokeConnectedSite`, the action the Revoke button dispatches);
 *  - the revoked site MUST RE-REQUEST: the dApp's `wallet_getPermissions` is now empty AND a gated
 *    method (`getPublicKeys`) is refused until it reconnects.
 *
 * No chain / no spend / no vault: the whole flow rides the shared per-origin consent store + the
 * real injected provider. (A live connect that returns an unlocked wallet's address is the separate
 * real-mainnet live-funds pass, not CI.)
 *
 * Run: `npm run build && npm run test:sw`.
 */

const EXT_PATH = resolve(process.cwd(), 'dist');

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let extensionId: string;
let worker: Worker;
let server: Server;
let dappOrigin: string;

/** Serve a minimal dApp page (any http origin gets the injected provider via the <all_urls> content script). */
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

/** Call window.chia.request in the dApp page; return a discriminated ok/err result (no throw across the boundary). */
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

test('a dApp connects, appears in Connected-sites, is revoked, and must re-request', async () => {
  const ext = await context.newPage();
  await ext.goto(`chrome-extension://${extensionId}/popup.html`);

  // The real dApp page — the <all_urls> content script injects window.chia here.
  const dapp = await context.newPage();
  await dapp.goto(`${dappOrigin}/`);
  await dapp.waitForFunction(() => !!(window as unknown as { chia?: unknown }).chia, undefined, { timeout: 15_000 });

  // Before connecting, the dApp has no permission (it must request access).
  const before = await dappRequest(dapp, 'wallet_getPermissions');
  expect(before.ok).toBe(true);
  expect((before.data as unknown[]).length).toBe(0);

  // The user approves the connection out-of-band — exactly what the popup's Connect prompt does.
  const consent = await swSend<{ success?: boolean }>(ext, { action: 'walletConsent', origin: dappOrigin, approved: true });
  expect(consent.success).not.toBe(false);

  // The dApp now SEES itself connected via the real injected provider (real origin → content → SW).
  const perms = await dappRequest(dapp, 'wallet_getPermissions');
  expect(perms.ok).toBe(true);
  expect(Array.isArray(perms.data)).toBe(true);
  expect((perms.data as unknown[]).length).toBe(1);

  // It shows up in Connected-sites (the settings screen's data source).
  const listed = await swSend<{ sites: { origin: string }[] }>(ext, { action: 'listConnectedSites' });
  expect(listed.sites.some((s) => s.origin === dappOrigin)).toBe(true);

  // Revoke it (the action the Connected-sites Revoke button dispatches).
  const revoked = await swSend<{ success?: boolean }>(ext, { action: 'revokeConnectedSite', origin: dappOrigin });
  expect(revoked.success).not.toBe(false);

  // Connected-sites no longer lists it.
  const after = await swSend<{ sites: { origin: string }[] }>(ext, { action: 'listConnectedSites' });
  expect(after.sites.some((s) => s.origin === dappOrigin)).toBe(false);

  // The revoked site MUST RE-REQUEST: its permissions are empty and a gated read is refused.
  const permsAfter = await dappRequest(dapp, 'wallet_getPermissions');
  expect(permsAfter.ok).toBe(true);
  expect((permsAfter.data as unknown[]).length).toBe(0);

  const gated = await dappRequest(dapp, 'getPublicKeys');
  expect(gated.ok, 'a revoked origin must NOT be able to call a gated method').toBe(false);

  await dapp.close();
  await ext.close();
});
