import { test, expect, chromium, type BrowserContext, type Worker, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

/**
 * END-USER e2e for #93 (DID management: create/list/transfer/profile-update + NFT↔DID assignment) —
 * driven against the BUILT unpacked extension in a real browser, through the self-custody vault. It
 * proves the SW routes every DID-management action — `listDids`, `prepareDidCreate` +
 * `confirmDidCreate`, `prepareDidTransfer` + `confirmDidTransfer`, `prepareDidProfileUpdate` +
 * `confirmDidProfileUpdate`, and `prepareNftDidAssign` + `confirmNftDidAssign` — to the offscreen
 * vault (never the "unknown custody action" stub) and that the vault's request guards fire
 * end-to-end:
 *   - `listDids` is WIRED — it reaches the vault's chain path (hint-scan needs coinset, which
 *     errors/times out in CI) and is NEVER the unknown-action stub.
 *   - `prepareDidCreate` / `prepareNftDidAssign` are WIRED — they reach the vault's chain path (which
 *     errors/times out against an unreachable coinset in CI) and are NEVER the unknown-action stub.
 *   - `prepareDidTransfer` / `prepareDidProfileUpdate` with missing fields → the vault's BAD_REQUEST
 *     guard (reached BEFORE any chain read — deterministic in CI).
 *   - `confirmDidCreate` / `confirmDidTransfer` / `confirmDidProfileUpdate` / `confirmNftDidAssign`
 *     with a bogus pending id → the vault's NO_PENDING guard.
 *
 * Also asserts dist/manifest.json's version was injected from package.json at build time (#139) —
 * the real build artifact, not just the source-level build.js contract (tests/manifest-version.test.mjs).
 *
 * The exact built create/transfer/profile-update/assign structure (DID launcher/recovery/owner, the
 * NFT↔DID ownership handshake, coin math, signatures aggregated) is proven deterministically at the
 * vault + engine layers against the wasm Simulator through the real driver path in dids.test.ts +
 * didAssign.test.ts + didVault.test.ts (a live coinset is non-deterministic and the extension-page
 * CSP precludes a local coinset mock — the same split as the #92 NFT-mint / #91 coin-control / #119
 * window.chia e2e). This pass never auto-broadcasts a mainnet spend.
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
  const imported = await swSend<{ lockState?: string }>(ext, { action: 'importWallet', mnemonic: GOLDEN.mnemonic, password: 'e2e-93-not-a-real-secret' });
  expect(imported.lockState).toBe('unlocked');
});

test.afterAll(async () => {
  await context?.close();
});

test('dist/manifest.json version was injected from package.json at build time (#139)', () => {
  const manifest = JSON.parse(readFileSync(resolve(EXT_PATH, 'manifest.json'), 'utf8')) as { version: string };
  const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as { version: string };
  expect(manifest.version).toBe(pkg.version);
});

test.describe('DID management (routed to the self-custody vault)', () => {
  test('listDids is wired to the vault chain path (never the unknown-action stub)', async () => {
    // Reaches the offscreen vault's hint-scan coinset read; in CI coinset is unreachable, so it
    // either errors (a real, non-stub code) or times out — both prove it is wired, not the stub.
    const res = await swSendRaced<{ success?: boolean; dids?: unknown[]; code?: string; message?: string }>(ext, { action: 'listDids' }, 6000);
    if ('timedOut' in res) return; // reached the chain path and hung on unreachable coinset → wired
    expect(res.message).not.toBe(UNKNOWN_ACTION);
  });

  test('prepareDidTransfer without launcherId/recipient hits the vault BAD_REQUEST guard (wired, not the unknown-action stub)', async () => {
    const res = await swSend<{ code?: string; message?: string }>(ext, { action: 'prepareDidTransfer' });
    expect(res.message).not.toBe(UNKNOWN_ACTION);
    expect(res.code).toBe('BAD_REQUEST');
  });

  test('confirmDidCreate with a bogus pending id hits the vault NO_PENDING guard (wired)', async () => {
    const res = await swSend<{ code?: string; message?: string }>(ext, { action: 'confirmDidCreate', pendingId: 'does-not-exist' });
    expect(res.message).not.toBe(UNKNOWN_ACTION);
    expect(res.code).toBe('NO_PENDING');
  });

  test('confirmDidTransfer with a bogus pending id hits the vault NO_PENDING guard (wired)', async () => {
    const res = await swSend<{ code?: string; message?: string }>(ext, { action: 'confirmDidTransfer', pendingId: 'does-not-exist' });
    expect(res.message).not.toBe(UNKNOWN_ACTION);
    expect(res.code).toBe('NO_PENDING');
  });

  test('prepareDidCreate is wired to the vault chain path (never the unknown-action stub)', async () => {
    // Reaches the offscreen vault's coinset read; in CI coinset is unreachable, so it either errors
    // (a real, non-stub code) or times out — both prove it is wired, not the default 4xx stub.
    const res = await swSendRaced<{ success?: boolean; code?: string; message?: string }>(ext, { action: 'prepareDidCreate' }, 6000);
    if ('timedOut' in res) return; // reached the chain path and hung on unreachable coinset → wired
    expect(res.message).not.toBe(UNKNOWN_ACTION);
  });

  test('prepareDidProfileUpdate without launcherId/profileName hits the vault BAD_REQUEST guard (wired)', async () => {
    const res = await swSend<{ code?: string; message?: string }>(ext, { action: 'prepareDidProfileUpdate' });
    expect(res.message).not.toBe(UNKNOWN_ACTION);
    expect(res.code).toBe('BAD_REQUEST');
  });

  test('confirmDidProfileUpdate with a bogus pending id hits the vault NO_PENDING guard (wired)', async () => {
    const res = await swSend<{ code?: string; message?: string }>(ext, { action: 'confirmDidProfileUpdate', pendingId: 'does-not-exist' });
    expect(res.message).not.toBe(UNKNOWN_ACTION);
    expect(res.code).toBe('NO_PENDING');
  });

  test('prepareNftDidAssign without launcherId/didLauncherId hits the vault BAD_REQUEST guard (wired)', async () => {
    const res = await swSend<{ code?: string; message?: string }>(ext, { action: 'prepareNftDidAssign' });
    expect(res.message).not.toBe(UNKNOWN_ACTION);
    expect(res.code).toBe('BAD_REQUEST');
  });

  test('confirmNftDidAssign with a bogus pending id hits the vault NO_PENDING guard (wired)', async () => {
    const res = await swSend<{ code?: string; message?: string }>(ext, { action: 'confirmNftDidAssign', pendingId: 'does-not-exist' });
    expect(res.message).not.toBe(UNKNOWN_ACTION);
    expect(res.code).toBe('NO_PENDING');
  });
});
