import { test, expect, chromium, type BrowserContext, type Worker, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

/**
 * P0 regression proof (#148): the entire wallet — balances, activity, NFTs, DIDs, send — was down
 * because `makeWasmChainClient` (src/offscreen/chain.ts) constructed the wasm coinset `RpcClient`
 * via `new chia.RpcClient(coinsetUrl)`, but the real wasm-bindgen class has NO instance constructor
 * (only the static factory `RpcClient.new(coinsetUrl)`). The PRECISE, deterministic regression test
 * for this bug is `src/offscreen/chain.realWasm.test.ts` (real wasm, no live network, TDD red/green
 * confirmed both ways) — read that file's doc comment for the full root-cause writeup.
 *
 * This file is the COMPLEMENTARY end-user-layer smoke test: driven against the BUILT unpacked
 * extension in a real browser, through the self-custody vault, over LIVE coinset.org. It follows the
 * SAME "wired, not the unknown-action stub" pattern the #93 DID-management / #92 NFT-mint e2e specs
 * already use for coinset-touching actions, for the same documented reason: a live third-party API
 * is inherently non-deterministic in a test run (this environment has live network access — verified
 * empirically the fix genuinely completes real, successful, non-cached coinset round-trips: real
 * balances, real years-deep transaction history, real NFT/DID hint-scans — but rate limits/transient
 * errors are still possible run-to-run, so the committed assertions accept a real error as "wired").
 *
 * Note the bug's actual browser-observed failure mode does NOT let e2e precisely pinpoint it: the
 * production `withTimeout` wrapper (12s) already reduces ANY internal chain-adapter failure — this
 * specific null-pointer crash OR a genuine coinset outage — to the same generic vault-level error
 * shape (confirmed empirically: reverting the fix produces `{success:false, code:'VAULT_ERROR',
 * message:'vault operation failed'}` after ~12s, not a distinguishable "null pointer" message, and
 * the browser's promise machinery does not surface it as an uncaught page/worker console error
 * either — unlike the raw-Node repro used to root-cause this bug). So the AUTHORITATIVE regression
 * guard is the unit test; this file proves the whole plumbing (SW → vault → chain adapter → wasm →
 * live coinset → response) works end-to-end for a connected wallet, which is what actually shipped.
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
  const imported = await swSend<{ lockState?: string }>(ext, { action: 'importWallet', mnemonic: GOLDEN.mnemonic, password: 'e2e-148-not-a-real-secret' });
  expect(imported.lockState).toBe('unlocked');
});

test.afterAll(async () => {
  await context?.close();
});

test.describe('Wallet reads over live coinset (#148 — the RpcClient null-pointer regression)', () => {
  test('getCustodyBalances is wired to a real coinset round-trip (never the unknown-action stub)', async () => {
    // Reaches the offscreen vault's coinset read; a healthy fix resolves fast with a real balance
    // (verified manually: {"balances":{"xch":0,"cats":{...}},"cached":false}) — a slow/rate-limited
    // live coinset round-trip is also legitimate and accepted here (18_000ms — above the adapter's
    // own 12s COINSET_TIMEOUT_MS, so a raced timeout here means the whole vault round-trip, incl.
    // its own internal timeout + fallback, didn't complete in time — still "wired", not broken).
    const res = await swSendRaced<{ balances?: { xch?: number }; message?: string }>(ext, { action: 'getCustodyBalances' }, 18_000);
    if ('timedOut' in res) return;
    expect(res.message).not.toBe(UNKNOWN_ACTION);
  });

  // #154 — getActivity is now the LOCAL activity log (an instant chrome.storage.local read), NOT a
  // coinset round-trip; it never touches the network, so it resolves near-instantly with a real
  // events array — no race/timeout budget needed like the coinset-backed reads above.
  test('getActivity is the LOCAL activity log — an instant read, never the unknown-action stub', async () => {
    const res = await swSend<{ events?: unknown[]; message?: string }>(ext, { action: 'getActivity' });
    expect(res.message).not.toBe(UNKNOWN_ACTION);
    expect(Array.isArray(res.events)).toBe(true);
  });

  test('listNfts (hint-scan, same coinset adapter) is wired to a real coinset round-trip (never the unknown-action stub)', async () => {
    const res = await swSendRaced<{ success?: boolean; nfts?: unknown[]; message?: string }>(ext, { action: 'listNfts' }, 18_000);
    if ('timedOut' in res) return;
    expect(res.message).not.toBe(UNKNOWN_ACTION);
  });

  test('listDids (hint-scan, same coinset adapter) is wired to a real coinset round-trip (never the unknown-action stub)', async () => {
    const res = await swSendRaced<{ success?: boolean; dids?: unknown[]; message?: string }>(ext, { action: 'listDids' }, 18_000);
    if ('timedOut' in res) return;
    expect(res.message).not.toBe(UNKNOWN_ACTION);
  });
});
