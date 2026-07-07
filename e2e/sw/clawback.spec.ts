import { test, expect, chromium, type BrowserContext, type Worker, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

/**
 * END-USER e2e for #152 (clawback) — the clawback actions driven against the BUILT unpacked
 * extension in a real browser, through the self-custody vault. Proves the SW routes
 * `listClawbacks`, `prepareClawbackAction`, and `prepareSend`'s `clawbackSeconds` option to the
 * offscreen vault (never the "unknown custody action" stub), and that the vault's request guards
 * fire end-to-end:
 *   - `prepareClawbackAction` with no direction/clawbackInfo → the vault's BAD_REQUEST guard
 *     (reached BEFORE any chain read — deterministic in CI, no coinset needed).
 *   - `prepareSend` with `clawbackSeconds` set on a CAT (assetId given) → BAD_REQUEST (v1 is
 *     XCH-only) — also reached before any chain read.
 *   - `listClawbacks` is WIRED — it reaches the vault's chain path (which errors/times out against
 *     an unreachable coinset in CI) and is NEVER the unknown-action stub.
 *
 * The exact built-spend structure (locked coin puzzle hash, memos, timelock enforcement — the
 * receiver can only claim after the window, the sender can only claw back strictly before it, coin
 * math/fee reservation) is proven deterministically at the offscreen layer against the wasm
 * Simulator through the real vault path in `clawback.test.ts` + `vault.test.ts` (a live coinset is
 * non-deterministic and the extension-page CSP precludes a local coinset mock — the same split as
 * the #91 coin-control e2e). This pass never auto-broadcasts a mainnet spend.
 *
 * Run: `npm run build && npm run test:sw`.
 */

const EXT_PATH = resolve(process.cwd(), 'dist');
const GOLDEN = JSON.parse(readFileSync(resolve(process.cwd(), 'src/lib/keystore/derive.golden.json'), 'utf8')) as { mnemonic: string };
const UNKNOWN_ACTION = 'unknown custody action';

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let extensionId: string;
let worker: Worker;
let ext: Page;

/** Send a chrome.runtime message from an extension page and resolve its reply. */
function swSend<T>(page: Page, message: Record<string, unknown>): Promise<T> {
  return page.evaluate((msg) => new Promise<T>((res) => chrome.runtime.sendMessage(msg, res as (r: unknown) => void)), message);
}

/** Send a SW message but give up after `ms` (a wired action may reach an unreachable-coinset hang in CI). */
function swSendRaced<T>(page: Page, message: Record<string, unknown>, ms: number): Promise<T | { timedOut: true }> {
  return page.evaluate(
    ({ msg, ms }) =>
      Promise.race<Promise<unknown>>([
        new Promise((res) => chrome.runtime.sendMessage(msg, res as (r: unknown) => void)),
        new Promise((res) => setTimeout(() => res({ timedOut: true }), ms)),
      ]) as Promise<T | { timedOut: true }>,
    { msg: message, ms },
  );
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
  ext = await context.newPage();
  await ext.goto(`chrome-extension://${extensionId}/popup.html`);
  const imported = await swSend<{ lockState?: string }>(ext, { action: 'importWallet', mnemonic: GOLDEN.mnemonic, password: 'e2e-152-not-a-real-secret' });
  expect(imported.lockState).toBe('unlocked');
});

test.afterAll(async () => {
  await context?.close();
});

test.describe('clawback (#152, routed to the self-custody vault)', () => {
  test('prepareClawbackAction with no direction/clawbackInfo hits the vault BAD_REQUEST guard (wired, not the unknown-action stub)', async () => {
    const res = await swSend<{ code?: string; message?: string }>(ext, { action: 'prepareClawbackAction' });
    expect(res.message).not.toBe(UNKNOWN_ACTION);
    expect(res.code).toBe('BAD_REQUEST');
  });

  test('prepareSend with clawbackSeconds on a CAT is rejected (v1 is XCH-only) — reached before any chain read', async () => {
    const res = await swSend<{ code?: string; message?: string }>(ext, {
      action: 'prepareSend',
      recipient: 'xch1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqzzzz',
      amount: '1000',
      assetId: 'ab'.repeat(32),
      clawbackSeconds: '9999999999',
    });
    expect(res.message).not.toBe(UNKNOWN_ACTION);
    expect(res.code).toBe('BAD_REQUEST');
  });

  test('listClawbacks is wired to the vault chain path (never the unknown-action stub)', async () => {
    // Reaches the offscreen vault's coinset read (hint discovery); in CI coinset is unreachable, so
    // it either errors (a real, non-stub code) or times out — both prove it is wired, not the
    // default 4xx stub.
    const res = await swSendRaced<{ success?: boolean; clawbacks?: unknown[]; code?: string; message?: string }>(ext, { action: 'listClawbacks' }, 6000);
    if ('timedOut' in res) return; // reached the chain path and hung on unreachable coinset → wired
    expect(res.message).not.toBe(UNKNOWN_ACTION);
  });

  test('confirmClawbackAction with no matching pending entry is wired (NO_PENDING, not the unknown-action stub)', async () => {
    const res = await swSend<{ code?: string; message?: string }>(ext, { action: 'confirmClawbackAction', pendingId: 'does-not-exist' });
    expect(res.message).not.toBe(UNKNOWN_ACTION);
    expect(res.code).toBe('NO_PENDING');
  });
});
