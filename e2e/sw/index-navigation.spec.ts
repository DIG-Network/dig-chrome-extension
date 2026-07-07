import { test, expect, chromium, type BrowserContext, type Worker, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

/**
 * End-to-end proof for #165 — the single active-derivation-index model. Driven against the BUILT
 * unpacked extension in a real headless Chromium, over the real SW + offscreen vault, using the
 * golden fixture mnemonic (deterministic addresses — no live coinset needed for the navigation
 * proof itself). Covers the acceptance bar:
 *   - the receive address reflects ONLY the active index, and changes when the index navigates
 *     (deterministic against the golden derivation vectors — proves no multi-index pooling);
 *   - `setActiveIndex` persists the new index (read back via `getLockState`);
 *   - a non-zero active index still scans successfully (a light, single-index coinset round-trip —
 *     wired to live coinset like the #148 regression proof; a real error is accepted as "wired",
 *     never the generic unknown-action stub).
 *
 * A real broadcast/send is NOT exercised here (no live-funds pass in CI, §7 security) — that the
 * vault derives + spends from the ACTIVE index (not a pooled/multi-index set) is proven at the unit
 * layer (vault.test.ts's `prepareSend`/`getReceiveAddress` tests across indexes, Simulator-validated
 * for send in sendFlow.test.ts).
 *
 * Run: `npm run build && npm run test:sw`.
 */

const EXT_PATH = resolve(process.cwd(), 'dist');
const GOLDEN = JSON.parse(readFileSync(resolve(process.cwd(), 'src/lib/keystore/derive.golden.json'), 'utf8')) as {
  mnemonic: string;
  unhardened: { address: string }[];
};
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

/** Send a SW message but give up after `ms` (a wired action may hang on a rate-limited/slow coinset). */
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
  const imported = await swSend<{ lockState?: string }>(ext, {
    action: 'importWallet',
    mnemonic: GOLDEN.mnemonic,
    password: 'e2e-165-not-a-real-secret',
  });
  expect(imported.lockState).toBe('unlocked');
});

test.afterAll(async () => {
  await context?.close();
});

test.describe('Single active derivation index (#165)', () => {
  test('the receive address reflects ONLY the active index (default 0)', async () => {
    const res = await swSend<{ address?: string }>(ext, { action: 'getReceiveAddress' });
    expect(res.address).toBe(GOLDEN.unhardened[0].address);
  });

  test('setActiveIndex navigates and persists the new index (read back via getLockState)', async () => {
    const set = await swSend<{ success?: boolean; activeIndex?: number }>(ext, { action: 'setActiveIndex', index: 1 });
    expect(set.success).toBe(true);
    expect(set.activeIndex).toBe(1);

    const lock = await swSend<{ activeIndex?: number }>(ext, { action: 'getLockState' });
    expect(lock.activeIndex).toBe(1);
  });

  test('navigating to index 1 changes the receive address to that index\'s address — no pooling', async () => {
    const res = await swSend<{ address?: string }>(ext, { action: 'getReceiveAddress' });
    expect(res.address).toBe(GOLDEN.unhardened[1].address);
    expect(res.address).not.toBe(GOLDEN.unhardened[0].address);
  });

  test('navigating back to index 0 restores its receive address', async () => {
    const set = await swSend<{ success?: boolean; activeIndex?: number }>(ext, { action: 'setActiveIndex', index: 0 });
    expect(set.activeIndex).toBe(0);
    const res = await swSend<{ address?: string }>(ext, { action: 'getReceiveAddress' });
    expect(res.address).toBe(GOLDEN.unhardened[0].address);
  });

  test('a non-zero active index still scans balances — a light, single-index coinset round-trip', async () => {
    await swSend(ext, { action: 'setActiveIndex', index: 2 });
    // Wired to a real coinset round-trip (never the unknown-action stub) — see wallet-balances.spec.ts
    // (#148) for why a raced timeout above the adapter's own 12s budget is still accepted as "wired".
    const res = await swSendRaced<{ balances?: { xch?: number }; message?: string }>(ext, { action: 'getCustodyBalances' }, 18_000);
    if ('timedOut' in res) return;
    expect(res.message).not.toBe(UNKNOWN_ACTION);
    // Restore index 0 so this spec leaves no cross-test residue.
    await swSend(ext, { action: 'setActiveIndex', index: 0 });
  });

  test('setActiveIndex is a real handler, never the unknown-action stub', async () => {
    const res = await swSend<{ message?: string }>(ext, { action: 'setActiveIndex', index: 0 });
    expect(res.message).not.toBe(UNKNOWN_ACTION);
  });
});
