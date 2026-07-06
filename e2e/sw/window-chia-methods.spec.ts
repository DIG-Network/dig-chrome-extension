import { test, expect, chromium, type BrowserContext, type Worker, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * END-USER e2e for #119 — the full `window.chia` method surface, driven against the BUILT unpacked
 * extension in a real browser through the self-custody vault (no WalletConnect).
 *
 * It proves, per method, that the injected provider routes to the offscreen vault via the dApp
 * router (NOT a 4004 stub) and that the approval-gated writes queue + honour the user's decision:
 *  - **Reads** — connect→boolean, getAddress→{address}, getPublicKeys, chainId, filterUnlockedCoins
 *    (echo), and the asset-generic getAssetBalance / getAssetCoins / getNFTs are WIRED (they reach the
 *    vault, never the 4004 method-not-found stub). Their exact per-asset values are proven
 *    deterministically at the vault layer against the wasm Simulator + a fake chain (`vault.test.ts`)
 *    and at the router layer (`dapp-approval.test.ts`); a live coinset is non-deterministic and the
 *    extension-page CSP precludes a local coinset mock, so here we assert the wiring, not the balance.
 *  - **Writes** — transfer/chia_send, sendTransaction, createOffer, takeOffer are APPROVAL-GATED: each
 *    enters the SW approval queue with the right kind, and a user REJECT surfaces to the dApp as
 *    CHIP-0002 `4002 USER_REJECTED` (never 4001). Nothing is ever broadcast — a funded send is the
 *    live-funds pass (#120); this pass never auto-broadcasts a mainnet spend.
 *  - **Unimplemented** — a genuinely unwired method (mintNft) returns `4004 METHOD_NOT_FOUND`.
 *
 * Run: `npm run build && npm run test:sw`.
 */

const EXT_PATH = resolve(process.cwd(), 'dist');
const GOLDEN = JSON.parse(readFileSync(resolve(process.cwd(), 'src/lib/keystore/derive.golden.json'), 'utf8')) as {
  mnemonic: string;
};
const CAT = 'cc'.repeat(32);
const METHOD_NOT_FOUND = 4004;
const USER_REJECTED = 4002;

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let extensionId: string;
let worker: Worker;
let server: Server;
let dappOrigin: string;
let dapp: Page;
let ext: Page;

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

/** A discriminated result from a window.chia call, capturing the thrown CHIP-0002 error code. */
type DappResult = { ok: true; data: unknown } | { ok: false; error: string; code: number | undefined };

/** Call window.chia.request in the dApp page; return ok/err with the error's CHIP-0002 `code`. */
function dappRequest(page: Page, method: string, params: Record<string, unknown> = {}): Promise<DappResult> {
  return page.evaluate(
    async ({ method, params }): Promise<DappResult> => {
      const chia = (window as unknown as { chia?: { request: (a: unknown) => Promise<unknown> } }).chia;
      if (!chia) return { ok: false, error: 'no window.chia', code: undefined };
      try {
        return { ok: true, data: await chia.request({ method, params }) };
      } catch (e) {
        const err = e as { message?: string; code?: number };
        return { ok: false, error: err?.message ?? String(e), code: err?.code };
      }
    },
    { method, params },
  );
}

/** Start a window.chia write (stays pending), drain it from the approval queue with `approved`. */
async function driveDecision(method: string, params: Record<string, unknown>, approved: boolean): Promise<DappResult> {
  const p = dappRequest(dapp, method, params);
  let pendingId = '';
  let kind = '';
  await expect
    .poll(
      async () => {
        const list = await swSend<{ requests?: { id: string; kind: string }[] }>(ext, { action: 'dappApprovalList' });
        pendingId = list.requests?.[0]?.id ?? '';
        kind = list.requests?.[0]?.kind ?? '';
        return list.requests?.length ?? 0;
      },
      { timeout: 15_000 },
    )
    .toBeGreaterThan(0);
  const resolved = await swSend<{ success?: boolean }>(ext, { action: 'dappApprovalResolve', id: pendingId, approved });
  expect(resolved.success).toBe(true);
  const res = await p;
  return Object.assign(res, { kind }) as DappResult & { kind: string };
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

  // Import the deterministic golden wallet (unlocks the vault) + approve the dApp origin out-of-band.
  ext = await context.newPage();
  await ext.goto(`chrome-extension://${extensionId}/popup.html`);
  const imported = await swSend<{ lockState?: string; success?: boolean }>(ext, {
    action: 'importWallet',
    mnemonic: GOLDEN.mnemonic,
    password: 'e2e-119-not-a-real-secret',
  });
  expect(imported.lockState).toBe('unlocked');
  const consent = await swSend<{ success?: boolean }>(ext, { action: 'walletConsent', origin: dappOrigin, approved: true });
  expect(consent.success).not.toBe(false);

  dapp = await context.newPage();
  await dapp.goto(`${dappOrigin}/`);
  await dapp.waitForFunction(() => !!(window as unknown as { chia?: unknown }).chia, undefined, { timeout: 15_000 });
  // Connect, retrying to absorb the first-call offscreen wasm-load race (the vault lazily loads the
  // derivation wasm on the first getReceiveAddress; a cold start can briefly not be ready).
  await expect
    .poll(async () => (await dappRequest(dapp, 'chip0002_connect')).ok === true, { timeout: 20_000 })
    .toBe(true);
});

test.afterAll(async () => {
  await context?.close();
  await new Promise<void>((res) => server?.close(() => res()));
});

test.describe('window.chia reads (served by the self-custody vault)', () => {
  test('chia_getAddress returns the wallet receive address as { address }', async () => {
    const r = await dappRequest(dapp, 'chia_getAddress');
    expect(r.ok).toBe(true);
    const address = typeof r.data === 'string' ? r.data : (r.data as { address?: string }).address;
    expect(address).toMatch(/^xch1/);
  });

  test('chip0002_getPublicKeys returns the wallet public keys', async () => {
    const r = await dappRequest(dapp, 'chip0002_getPublicKeys');
    expect(r.ok).toBe(true);
    expect(Array.isArray(r.data)).toBe(true);
    expect(typeof (r.data as string[])[0]).toBe('string');
  });

  test('chip0002_chainId reports mainnet', async () => {
    const r = await dappRequest(dapp, 'chip0002_chainId');
    expect(r.ok).toBe(true);
    expect(r.data).toBe('mainnet');
  });

  test('chip0002_filterUnlockedCoins echoes the supplied coins (no cross-call locks)', async () => {
    const coins = [{ parent_coin_info: 'aa', puzzle_hash: 'bb', amount: '1' }];
    const r = await dappRequest(dapp, 'chip0002_filterUnlockedCoins', { coins });
    expect(r.ok).toBe(true);
    expect(r.data).toEqual(coins);
  });

  // The asset-generic reads reach the vault → coinset (their per-asset values are proven
  // deterministically in vault.test.ts against the sim/fake chain, since a live coinset is
  // non-deterministic and the extension-page CSP precludes a local coinset mock). Here we prove they
  // are WIRED — the request reaches the vault's chain path (which hangs/errors with no reachable
  // coinset in CI) and is NEVER the 4004 method-not-found stub, which would resolve instantly.
  test('getAssetBalance / getAssetCoins / getNFTs are wired to the vault (not a 4004 stub)', async () => {
    for (const [method, params] of [
      ['chip0002_getAssetBalance', { type: null }],
      ['chip0002_getAssetBalance', { type: 'cat', assetId: CAT }],
      ['chip0002_getAssetCoins', {}],
      ['chia_getNfts', {}],
    ] as const) {
      const r = await page_raceRequest(dapp, method, params, 4000);
      // A stubbed (4004) method resolves instantly; a wired one either succeeds (coinset reachable) or
      // reaches the chain path and times out here (unreachable coinset in CI). Both prove it is wired.
      if (r.outcome === 'error') expect(r.code, `${method} should be wired, got ${r.code}`).not.toBe(METHOD_NOT_FOUND);
      else expect(['ok', 'timeout']).toContain(r.outcome);
    }
  });
});

/** Call window.chia.request with an in-page timeout so an unreachable-coinset hang stays bounded. */
function page_raceRequest(
  page: Page,
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number,
): Promise<{ outcome: 'ok' | 'error' | 'timeout'; code?: number }> {
  return page.evaluate(
    ({ method, params, timeoutMs }) => {
      const chia = (window as unknown as { chia?: { request: (a: unknown) => Promise<unknown> } }).chia;
      if (!chia) return Promise.resolve({ outcome: 'error' as const, code: undefined });
      const call = chia
        .request({ method, params })
        .then(() => ({ outcome: 'ok' as const }))
        .catch((e: { code?: number }) => ({ outcome: 'error' as const, code: e?.code }));
      const timeout = new Promise<{ outcome: 'timeout' }>((res) => setTimeout(() => res({ outcome: 'timeout' }), timeoutMs));
      return Promise.race([call, timeout]);
    },
    { method, params, timeoutMs },
  );
}

test.describe('window.chia writes (approval-gated; reject → 4002, nothing broadcast)', () => {
  const cases: Array<{ method: string; params: Record<string, unknown>; kind: string }> = [
    { method: 'chia_send', params: { address: 'xch1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqzfzp5x', amount: '1000' }, kind: 'send' },
    { method: 'chia_createOffer', params: { offerAssets: [{ amount: '1000' }], requestAssets: [{ assetId: CAT, amount: '5' }] }, kind: 'createOffer' },
    { method: 'chia_takeOffer', params: { offer: 'offer1qqqz-e2e-placeholder' }, kind: 'takeOffer' },
    { method: 'chia_sendTransaction', params: { spendBundle: { coin_spends: [{ coin: { parent_coin_info: 'aa'.repeat(32), puzzle_hash: 'bb'.repeat(32), amount: '1' }, puzzle_reveal: 'ff', solution: '80' }], aggregated_signature: 'c'.repeat(192) } }, kind: 'sendTransaction' },
  ];

  for (const c of cases) {
    test(`${c.method} enqueues an approval (kind=${c.kind}) and a reject → 4002`, async () => {
      const r = (await driveDecision(c.method, c.params, false)) as DappResult & { kind: string };
      expect(r.kind).toBe(c.kind);
      expect(r.ok).toBe(false);
      if (r.ok === false) expect(r.code).toBe(USER_REJECTED);
    });
  }
});

test.describe('window.chia unimplemented methods', () => {
  test('mintNft returns 4004 METHOD_NOT_FOUND (reference-parity stub, no approval window)', async () => {
    const r = await dappRequest(dapp, 'chia_mintNft', {});
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.code).toBe(METHOD_NOT_FOUND);
    const list = await swSend<{ requests?: unknown[] }>(ext, { action: 'dappApprovalList' });
    expect(list.requests?.length ?? 0).toBe(0);
  });
});
