import { test, expect, chromium, type BrowserContext, type Worker, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * End-to-end proof for #76 P1-4's acceptance bar: "a session cannot outlive TTL via a held
 * approval window." A dApp SIGNING request (`chip0002_signMessage`) is queued in the SW's approval
 * manager (a keepalive port from the approval window would normally hold the SW alive indefinitely
 * while the user reviews it); this test forces the unlock-expiry into the PAST — simulating the TTL
 * lapsing while the request sits in the queue, BEFORE the periodic 1-minute auto-lock alarm has had
 * a chance to tick — then approves. The approval must be REFUSED (never signed), because the SW's
 * `dappApproval` `callVault` wrapper re-checks the live lock snapshot on every call, not just on the
 * alarm's schedule (`src/background/index.ts`).
 *
 * `signMessage` is chosen deliberately over a send/offer write: it signs LOCALLY with the cached
 * key (no coin selection, no chain read), so there is no live-coinset dependency to confound the
 * result — a build/network failure could otherwise refuse the request for an unrelated reason and
 * produce a false-positive pass. Every dApp-router call (reads, signs, writes alike) is funnelled
 * through the SAME `callVault` wrapper this test exercises, so proving the gate here proves it for
 * the write kinds too.
 *
 * Driven against the BUILT unpacked extension in real headless Chromium, over the real SW +
 * offscreen vault.
 *
 * Run: `npm run build && npm run test:sw`.
 */

const EXT_PATH = resolve(process.cwd(), 'dist');
const GOLDEN = JSON.parse(readFileSync(resolve(process.cwd(), 'src/lib/keystore/derive.golden.json'), 'utf8')) as { mnemonic: string };
const PASSWORD = 'e2e-76-ttl-race-not-a-real-secret';
const UNLOCK_EXPIRY_KEY = 'wallet.unlockExpiry';

let context: BrowserContext;
let extensionId: string;
let worker: Worker;
let server: Server;
let dappOrigin: string;

function startDappServer(): Promise<Server> {
  return new Promise((res) => {
    const s = createServer((_req, reply) => {
      reply.writeHead(200, { 'content-type': 'text/html' });
      reply.end('<!doctype html><html><head><title>TTL race dApp</title></head><body></body></html>');
    });
    s.listen(0, '127.0.0.1', () => res(s));
  });
}

function swSend<T>(page: Page, message: Record<string, unknown>): Promise<T> {
  return page.evaluate((msg) => new Promise<T>((res) => chrome.runtime.sendMessage(msg, res as (r: unknown) => void)), message);
}

type DappResult = { ok: true; data: unknown } | { ok: false; error: string; code: number | undefined };

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

/** Force the unlock-expiry to an already-PAST timestamp WITHOUT calling `lockWallet` — the vault
 * still holds the decrypted key, exactly as it would if the periodic auto-lock alarm simply hasn't
 * ticked yet. This is the precise race #76 closes: the TTL number says "expired" a moment before
 * the alarm/idle listener gets around to acting on it. */
function forceExpiredUnlock(page: Page): Promise<void> {
  return page.evaluate((key) => chrome.storage.session.set({ [key]: Date.now() - 5_000 }), UNLOCK_EXPIRY_KEY);
}

/**
 * `chrome.idle` reports the OS session as `locked` almost immediately in a headless/no-real-display
 * Chromium (verified empirically by `session-persist.spec.ts`'s `skipIfEnvironmentIdleLocked`) — a
 * pre-existing, unrelated auto-lock trigger that can race an unrelated setup step. Re-unlock
 * whenever a check finds the session already locked, so THIS test's own deliberate force-expire
 * (below) is the only thing under assertion, never an environmental idle flake.
 */
async function ensureUnlocked(page: Page): Promise<void> {
  const state = await swSend<{ lockState?: string }>(page, { action: 'getLockState' });
  if (state.lockState === 'unlocked') return;
  const res = await swSend<{ lockState?: string }>(page, { action: 'unlockWallet', password: PASSWORD });
  expect(res.lockState).toBe('unlocked');
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

test('a queued dApp sign request approved AFTER the TTL lapses (alarm not yet fired) is refused, never signed', async () => {
  const ext = await context.newPage();
  await ext.goto(`chrome-extension://${extensionId}/popup.html`);
  const imported = await swSend<{ lockState?: string }>(ext, { action: 'importWallet', mnemonic: GOLDEN.mnemonic, password: PASSWORD });
  expect(imported.lockState).toBe('unlocked');
  const consent = await swSend<{ success?: boolean }>(ext, { action: 'walletConsent', origin: dappOrigin, approved: true });
  expect(consent.success).not.toBe(false);

  const dapp = await context.newPage();
  await dapp.goto(`${dappOrigin}/`);
  await dapp.waitForFunction(() => !!(window as unknown as { chia?: unknown }).chia, undefined, { timeout: 15_000 });
  await ensureUnlocked(ext);
  await expect
    .poll(async () => {
      await ensureUnlocked(ext); // absorb a stray environmental idle-lock between polls
      return (await dappRequest(dapp, 'chip0002_connect')).ok === true;
    }, { timeout: 20_000 })
    .toBe(true);
  await ensureUnlocked(ext);

  // Queue a signing request — it stays pending until resolved (simulates a held approval window).
  const pending = dappRequest(dapp, 'chip0002_signMessage', { message: 'hello from the TTL-race e2e' });
  let pendingId = '';
  await expect
    .poll(async () => {
      const list = await swSend<{ requests?: { id: string }[] }>(ext, { action: 'dappApprovalList' });
      pendingId = list.requests?.[0]?.id ?? '';
      return list.requests?.length ?? 0;
    }, { timeout: 15_000 })
    .toBeGreaterThan(0);

  // The TTL "lapses" while the request sits in the queue — the vault still has the key cached
  // (lockWallet was never called), exactly matching the window before the next alarm tick.
  await forceExpiredUnlock(ext);

  // Approve it now — this must be REFUSED, not signed/broadcast, even though the vault could still
  // technically produce a signature (nothing has zeroized its key yet).
  const resolved = await swSend<{ success?: boolean; code?: string }>(ext, { action: 'dappApprovalResolve', id: pendingId, approved: true });
  expect(resolved.success).toBe(true); // the RESOLVE call itself succeeds (a decision was recorded)

  const result = await pending;
  expect(result.ok).toBe(false); // the dApp's `signMessage` promise must reject, never resolve with a signature

  // The lock-state read confirms the session is now genuinely locked (the gate tidied up the vault
  // on the way out), not left in some half-unlocked limbo.
  const lockState = await swSend<{ lockState?: string }>(ext, { action: 'getLockState' });
  expect(lockState.lockState).toBe('locked');

  await ext.close();
  await dapp.close();
});
