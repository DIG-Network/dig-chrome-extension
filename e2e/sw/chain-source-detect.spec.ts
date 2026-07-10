import { test, expect, chromium, type BrowserContext, type Worker, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * END-USER e2e for #222 — proves, against the BUILT unpacked extension in a real browser, that the
 * extension ACTIVELY surfaces a locally-reachable dig-node as the wallet-data source WITHOUT a
 * separate `chainSourceUrl` override, and shows the new "Local dig-node detected" indicator:
 *
 *   1. Auto mode + ONLY `server.host` configured (the SAME host the content/chia:// path already
 *      used, §5.3) — zero `chainSourceUrl` — auto-SELECTs the reachable node as the wallet-data
 *      source (`getChainSourceStatus` reports `{ mode:'auto', resolved:{ kind:'node', strict:false } }`).
 *      Before #222 this path had no live status surface for the UI to show; #222 adds the
 *      `getChainSourceStatus` action + the indicator this test proves.
 *   2. The Settings panel renders the indicator naming the resolved endpoint, screenshotted (§6.5).
 *   3. Auto mode falls back to coinset — never a false "detected" — when nothing answers.
 *   4. A user-FORCED mode (node/custom/coinset) shows no indicator even though the same node
 *      answers — the indicator is scoped to Auto's zero-config detection only.
 *
 * Binds the fake node to the {@link LOOPBACK_IP} literal `127.0.0.5` — the SAME real-socket
 * convention `dig-node-control.spec.ts` documents: an IPv4-only Node test server bound to bare
 * `localhost`/`127.0.0.1` looks UNREACHABLE to the browser here (Chrome's `::1`-first resolution
 * finding nothing there and not falling back within the probe timeout — the bug that sank the
 * first `127.0.0.1` e2e cut). `127.0.0.5` is in `host_permissions` and is NOT a §5.3 local alias,
 * so configuring it as `server.host` drives the ladder's CUSTOM-node tier verbatim — the alias
 * tiers' ORDERING (`dig.local` before `localhost:<port>`) are exhaustively unit-tested with an
 * injected fetch in `src/lib/dig-node-resolve.test.ts`, which this e2e does not duplicate. What is
 * NEW here and worth a real socket: the wallet path now shares that ONE `server.host` setting
 * (previously wallet-data needed its own `chainSourceUrl` to reach a non-default node) and reports
 * a live, user-visible detection status.
 *
 * Run: `npm run build && npm run test:sw`.
 */

const EXT_PATH = resolve(process.cwd(), 'dist');
const GOLDEN = JSON.parse(readFileSync(resolve(process.cwd(), 'src/lib/keystore/derive.golden.json'), 'utf8')) as { mnemonic: string };
/** See the file header — a real IPv4-only Node server bound to `localhost`/`127.0.0.1` is not
 * reliably reachable from the browser in this harness; `127.0.0.5` is the proven-working literal. */
const LOOPBACK_IP = '127.0.0.5';

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let extensionId: string;
let worker: Worker;

function swSend<T>(page: Page, message: Record<string, unknown>): Promise<T> {
  return page.evaluate((msg) => new Promise<T>((res) => chrome.runtime.sendMessage(msg, res as (r: unknown) => void)), message);
}

/**
 * Re-unlock the wallet on THIS page before a UI-driven test. The wallet-import unlock from
 * `beforeAll` can drop by the time a LATER serial test runs (the offscreen vault's in-memory key
 * does not necessarily survive an MV3 service-worker/offscreen-document lifecycle event across the
 * wall-clock time several earlier tests + their real loopback I/O take) — a UI test that navigates
 * straight to the wallet screen without re-confirming unlocked state can otherwise land on the
 * "Unlock your wallet" gate instead of `ChainSourceSetting`. Idempotent: unlocking an
 * already-unlocked wallet is a no-op.
 */
async function ensureUnlocked(page: Page): Promise<void> {
  const res = await swSend<{ lockState?: string }>(page, { action: 'unlockWallet', password: 'e2e-222-not-a-real-secret' });
  expect(res.lockState).toBe('unlocked');
}

/** Set the content-path/wallet-ladder host (`server.host`) — what a user configures ONCE under
 * Resolver/Settings, shared by BOTH the chia:// content path and the wallet-data ladder (#222). */
async function setServerHost(page: Page, host: string): Promise<void> {
  await page.evaluate(async (h) => {
    await chrome.storage.local.set({ 'server.host': h });
  }, host);
}

/** Set the wallet-data chain-source MODE only — never the custom URL (that override tier is
 * `node-wallet-source.spec.ts`'s job). */
async function setChainSourceMode(page: Page, mode: string): Promise<void> {
  await page.evaluate(async (m) => {
    const cur = (await chrome.storage.local.get('wallet.settings'))['wallet.settings'] || {};
    await chrome.storage.local.set({ 'wallet.settings': { ...cur, chainSourceMode: m } });
  }, mode);
}

/** A tiny REAL loopback server answering the ladder's no-cors reachability GET, plus a minimal
 * Sage `get_sync_status`/`get_cats` so a wallet-data read against it resolves cleanly. */
function startFakeNode(): Promise<{ server: Server; port: number }> {
  return new Promise((resolvePromise, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const cors = {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'content-type',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
      };
      if (req.method === 'OPTIONS') {
        res.writeHead(204, cors);
        res.end();
        return;
      }
      if (req.method === 'GET') {
        res.writeHead(200, { ...cors, 'content-type': 'text/plain' });
        res.end('ok'); // the reachability probe
        return;
      }
      if (req.method === 'POST') {
        const path = (req.url || '').split('?')[0];
        const body = path === '/get_cats' ? { cats: [] } : { selectable_balance: 0, synced_coins: 0, total_coins: 0 };
        res.writeHead(200, { ...cors, 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
        return;
      }
      res.writeHead(405, cors);
      res.end();
    });
    server.on('error', reject);
    server.listen(0, LOOPBACK_IP, () => resolvePromise({ server, port: (server.address() as AddressInfo).port }));
  });
}

function stopFakeNode(server: Server | null | undefined): Promise<void> {
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
  const ext = await context.newPage();
  await ext.goto(`chrome-extension://${extensionId}/popup.html`);
  const imported = await swSend<{ lockState?: string }>(ext, {
    action: 'importWallet',
    mnemonic: GOLDEN.mnemonic,
    password: 'e2e-222-not-a-real-secret',
  });
  expect(imported.lockState).toBe('unlocked');
  await ext.close();
});

test.afterAll(async () => {
  await context?.close();
});

test('Auto mode, zero chainSourceUrl — a node reachable via server.host is auto-selected as the wallet-data source', async () => {
  const { server, port } = await startFakeNode();
  try {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await setServerHost(page, `${LOOPBACK_IP}:${port}`);
    await setChainSourceMode(page, 'auto'); // the default — set explicitly for test clarity

    const status = await swSend<{ mode?: string; resolved?: { kind?: string; base?: string; strict?: boolean } }>(page, {
      action: 'getChainSourceStatus',
    });
    expect(status.mode).toBe('auto');
    expect(status.resolved?.kind).toBe('node');
    expect(status.resolved?.base).toBe(`http://${LOOPBACK_IP}:${port}`);
    expect(status.resolved?.strict).toBe(false);
    await page.close();
  } finally {
    await stopFakeNode(server);
  }
});

test('Auto mode, no node reachable — resolves to coinset (clean fallback, never a false "detected")', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  // A distinct, definitely-unbound port — deterministic regardless of environment.
  await setServerHost(page, `${LOOPBACK_IP}:19778`);
  await setChainSourceMode(page, 'auto');
  const status = await swSend<{ mode?: string; resolved?: { kind?: string } }>(page, { action: 'getChainSourceStatus' });
  expect(status.mode).toBe('auto');
  expect(status.resolved?.kind).toBe('coinset');
  await page.close();
});

test('"Local dig-node detected" indicator renders in Auto mode + screenshots the panel (§6.5)', async () => {
  const { server, port } = await startFakeNode();
  try {
    const page = await context.newPage();
    await page.setViewportSize({ width: 1200, height: 900 });
    // Configure storage + re-confirm unlocked from an already-loaded extension page FIRST, then
    // navigate to the settings screen — so the panel mounts with the node already reachable and the
    // wallet already unlocked, not racing a fetch/unlock-gate fired before the writes landed.
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await setServerHost(page, `${LOOPBACK_IP}:${port}`);
    await setChainSourceMode(page, 'auto');
    await ensureUnlocked(page);
    await page.goto(`chrome-extension://${extensionId}/app.html#wallet/home`);

    await expect(page.getByTestId('chain-source-select')).toBeVisible({ timeout: 20_000 });

    const pill = page.getByTestId('chain-source-detected-pill');
    await expect(pill).toBeVisible({ timeout: 20_000 });
    await expect(pill).toContainText('Local dig-node detected');
    await expect(pill).toContainText(`${LOOPBACK_IP}:${port}`);

    await page.getByTestId('chain-source-setting').scrollIntoViewIfNeeded();
    await page.waitForTimeout(150);
    await page.screenshot({ path: 'e2e/__screenshots__/chain-source-detected-indicator-fullscreen.png' });
    await page.close();
  } finally {
    await stopFakeNode(server);
  }
});

test('override wins — a user-FORCED mode shows no indicator even though the same node answers', async () => {
  const { server, port } = await startFakeNode();
  try {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await setServerHost(page, `${LOOPBACK_IP}:${port}`);
    await setChainSourceMode(page, 'node'); // forced, not auto
    await ensureUnlocked(page);
    await page.goto(`chrome-extension://${extensionId}/app.html#wallet/home`);

    const select = page.getByTestId('chain-source-select');
    await expect(select).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => select.inputValue()).toBe('node');
    await expect(page.getByTestId('chain-source-detected-pill')).toHaveCount(0);
    await page.close();
  } finally {
    await stopFakeNode(server);
  }
});
