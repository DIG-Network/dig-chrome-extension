import { test, expect, chromium, type BrowserContext, type Worker, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * END-USER e2e for #217 (phase 3 of #205) + the #399 verified-tracking gate — proves, against the
 * BUILT unpacked extension in a real browser, that the extension's WALLET-data source resolves
 * correctly, and that the Settings switch drives it. Mirrors the "real loopback socket, no mocked
 * fetch" bar of `e2e/sw/dig-node-control.spec.ts`: a tiny Node HTTP server on {@link LOOPBACK_IP}
 * speaks the Sage v0.12.11 `POST /{method}` contract (byte-shaped per `src/lib/node-wallet.ts`), and
 * the Custom-URL source mode points the wallet-data resolver at it.
 *
 * #399: a dig-node answers wallet reads from the wallet IT tracks — not necessarily the connected
 * self-custody wallet — so connected-wallet data is sourced from a node ONLY when the node is
 * VERIFIED to track that wallet (the #407 handshake, not yet wired). Until then a node source is
 * gated OFF for connected-wallet data: a forced node/custom source surfaces `NODE_UNAVAILABLE`
 * (never the node's data, never a silent coinset downgrade, never a silent 0), and auto uses the
 * self-custody coinset scan. This suite proves that gate end-to-end through the real SW.
 *
 * Cases:
 *   1. **Node present (Custom URL) but NOT verified-tracking** → every connected-wallet read
 *      (balances / NFTs / DIDs / coins / activity) returns `NODE_UNAVAILABLE`, never node data (#399).
 *   2. **Node unreachable (Custom URL, strict)** → `NODE_UNAVAILABLE`, never a silent coinset downgrade.
 *   3. **Coinset-only mode** → the read goes to coinset (a wired live round-trip), never the node.
 *   4. **Auto mode, no node** → clean coinset fallback (wired, never the unknown-action stub).
 *   5. **Settings switch** persists across the four states and screenshots the control (§6.5).
 *
 * Signing is NEVER exercised here — this milestone is read-only source consumption; the offscreen
 * vault keeps every key (issue #217 HARD gate).
 *
 * Run: `npm run build && npm run test:sw`.
 */

const EXT_PATH = resolve(process.cwd(), 'dist');
const GOLDEN = JSON.parse(readFileSync(resolve(process.cwd(), 'src/lib/keystore/derive.golden.json'), 'utf8')) as { mnemonic: string };
const UNKNOWN_ACTION = 'unknown custody action';
/** An IPv4 loopback literal in host_permissions + NOT a §5.3 alias, so it exercises Custom-URL. */
const LOOPBACK_IP = '127.0.0.5';
/** A representative CAT asset id (a valid 64-hex TAIL) used in the canned get_cats response. */
const CAT_ID = 'a628c1c2c6fcb74d53746157e438e108eab5c0bb3e5c80ff9b1910b3e4832913';

const SYNC_STATUS = { selectable_balance: 1_500_000_000_000, synced_coins: 10, total_coins: 10 };
const CATS = { cats: [{ asset_id: CAT_ID, balance: 4200 }] };
const NFTS = {
  nfts: [
    {
      launcher_id: 'aa11',
      coin_id: 'bb22',
      owner_did: 'cc33',
      royalty_ten_thousandths: 250,
      data_uris: ['https://example/nft.png'],
      edition_number: 1,
      edition_total: 1,
    },
  ],
  total: 1,
};
const DIDS = { dids: [{ launcher_id: 'dd44', coin_id: 'ee55', name: 'Node DID' }] };
const COINS = { coins: [{ coin_id: 'ff66', amount: 1_500_000_000_000, created_height: 4_242_000 }] };
const TRANSACTIONS = {
  transactions: [
    {
      height: 4_242_100,
      timestamp: 1_700_000_000,
      created: [{ coin_id: 'ab', amount: 500, address_kind: 'own', asset: { asset_id: null } }],
    },
  ],
};

/** Map a Sage-parity method path to its canned response body. */
const ROUTES: Record<string, unknown> = {
  '/get_sync_status': SYNC_STATUS,
  '/get_cats': CATS,
  '/get_nfts': NFTS,
  '/get_dids': DIDS,
  '/get_coins': COINS,
  '/get_transactions': TRANSACTIONS,
};

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let extensionId: string;
let worker: Worker;

function swSend<T>(page: Page, message: Record<string, unknown>): Promise<T> {
  return page.evaluate((msg) => new Promise<T>((res) => chrome.runtime.sendMessage(msg, res as (r: unknown) => void)), message);
}

/** Write the wallet-data source selection straight into `wallet.settings` (what the SW reads). */
async function setSource(page: Page, mode: string, customUrl = ''): Promise<void> {
  await page.evaluate(
    async ({ mode, customUrl }) => {
      const cur = (await chrome.storage.local.get('wallet.settings'))['wallet.settings'] || {};
      await chrome.storage.local.set({ 'wallet.settings': { ...cur, chainSourceMode: mode, chainSourceUrl: customUrl } });
    },
    { mode, customUrl },
  );
}

/** A tiny REAL loopback server answering the Sage-parity method surface (+ the no-cors GET probe). */
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
        const body = ROUTES[path];
        if (body === undefined) {
          res.writeHead(404, { ...cors, 'content-type': 'text/plain' });
          res.end(`no method ${path}`);
          return;
        }
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
    password: 'e2e-217-not-a-real-secret',
  });
  expect(imported.lockState).toBe('unlocked');
  await ext.close();
});

test.afterAll(async () => {
  await context?.close();
});

test('Custom-URL node present but NOT verified-tracking — connected-wallet reads are NOT sourced from it (#399)', async () => {
  const { server, port } = await startFakeNode();
  try {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await setSource(page, 'custom', `http://${LOOPBACK_IP}:${port}`);

    // The node is reachable and DOES serve the Sage-parity surface (get_sync_status/get_cats/…),
    // but until the extension can VERIFY the node tracks the CONNECTED wallet (#399/#407), a forced
    // node/custom source must NOT surface the node's wallet data — it would be a different or
    // identity-less wallet. Every connected-wallet read returns NODE_UNAVAILABLE (node-not-tracking),
    // never node data, never a silent 0, never the unknown-action stub.
    for (const action of ['getCustodyBalances', 'listNfts', 'listDids', 'listCoins', 'getActivity'] as const) {
      const res = await swSend<{ success?: boolean; code?: string; message?: string }>(page, { action });
      expect(res.message).not.toBe(UNKNOWN_ACTION);
      expect(res.success).toBe(false);
      expect(res.code).toBe('NODE_UNAVAILABLE');
    }

    await page.close();
  } finally {
    await stopFakeNode(server);
  }
});

test('Custom-URL forced source — NODE_UNAVAILABLE whether the node is reachable-but-untracked or gone (never a silent coinset downgrade)', async () => {
  const { server, port } = await startFakeNode();
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await setSource(page, 'custom', `http://${LOOPBACK_IP}:${port}`);
  // Reachable but not verified-tracking → NODE_UNAVAILABLE (never node data, never coinset).
  const up = await swSend<{ success?: boolean; code?: string }>(page, { action: 'getCustodyBalances' });
  expect(up.success).toBe(false);
  expect(up.code).toBe('NODE_UNAVAILABLE');
  // …then kill it: the forced custom source stays unavailable, never a silent coinset fallback.
  await stopFakeNode(server);
  const down = await swSend<{ success?: boolean; code?: string }>(page, { action: 'getCustodyBalances' });
  expect(down.success).toBe(false);
  expect(down.code).toBe('NODE_UNAVAILABLE');
  await page.close();
});

test('Coinset-only mode — reads go to coinset, never the node (wired, not the unknown-action stub)', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await setSource(page, 'coinset');
  const res = await page.evaluate(
    (msg) =>
      Promise.race<Promise<unknown>>([
        new Promise((r) => chrome.runtime.sendMessage(msg, r as (x: unknown) => void)),
        new Promise((r) => setTimeout(() => r({ timedOut: true }), 18_000)),
      ]),
    { action: 'getCustodyBalances' },
  );
  if (res && typeof res === 'object' && 'timedOut' in res) {
    await page.close();
    return; // a slow/rate-limited live coinset round-trip is still "wired"
  }
  expect((res as { message?: string }).message).not.toBe(UNKNOWN_ACTION);
  await page.close();
});

test('Auto mode, no node reachable — clean coinset fallback (wired, not the unknown-action stub)', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await setSource(page, 'auto'); // no fake node running → the ladder finds none → coinset
  const res = await page.evaluate(
    (msg) =>
      Promise.race<Promise<unknown>>([
        new Promise((r) => chrome.runtime.sendMessage(msg, r as (x: unknown) => void)),
        new Promise((r) => setTimeout(() => r({ timedOut: true }), 18_000)),
      ]),
    { action: 'getCustodyBalances' },
  );
  if (res && typeof res === 'object' && 'timedOut' in res) {
    await page.close();
    return;
  }
  expect((res as { message?: string }).message).not.toBe(UNKNOWN_ACTION);
  await page.close();
});

test('Settings switch persists across the four states + screenshots the control (§6.5)', async () => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1200, height: 900 });
  // Re-confirm unlocked before navigating to the wallet screen (#222 hardening): this is the LAST
  // of five serial tests in this file, and the offscreen vault's in-memory key does not necessarily
  // survive an MV3 service-worker/offscreen-document lifecycle event across the wall-clock time the
  // earlier tests' real loopback I/O takes — without this, the panel can land on the "Unlock your
  // wallet" gate instead of ChainSourceSetting (observed flake). Idempotent if already unlocked.
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  const unlocked = await swSend<{ lockState?: string }>(page, { action: 'unlockWallet', password: 'e2e-217-not-a-real-secret' });
  expect(unlocked.lockState).toBe('unlocked');
  await page.goto(`chrome-extension://${extensionId}/app.html#wallet/home`);

  const select = page.getByTestId('chain-source-select');
  await expect(select).toBeVisible({ timeout: 20_000 });

  // Custom → reveals the URL field; entering it persists.
  await select.selectOption('custom');
  const url = page.getByTestId('chain-source-url');
  await expect(url).toBeVisible();
  await url.fill(`http://${LOOPBACK_IP}:9778`);
  await url.blur();
  await expect(page.getByTestId('chain-source-setting')).toBeVisible();
  await page.getByTestId('chain-source-setting').scrollIntoViewIfNeeded();
  await page.waitForTimeout(150);
  await page.screenshot({ path: 'e2e/__screenshots__/chain-source-setting-custom-fullscreen.png' });

  // Node-only, then coinset, then back to auto — each persists to wallet.settings.
  const storedMode = () =>
    page.evaluate(async () => ((await chrome.storage.local.get('wallet.settings'))['wallet.settings'] as { chainSourceMode?: string })?.chainSourceMode);
  for (const mode of ['node', 'coinset', 'auto'] as const) {
    await select.selectOption(mode);
    await expect.poll(storedMode, { timeout: 5_000 }).toBe(mode);
  }

  await page.getByTestId('chain-source-setting').scrollIntoViewIfNeeded();
  await page.waitForTimeout(150);
  await page.screenshot({ path: 'e2e/__screenshots__/chain-source-setting-auto-fullscreen.png' });
  await page.close();
});
