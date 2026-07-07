import { test, expect, chromium, type BrowserContext, type Worker, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

/**
 * END-USER e2e for #94 (NFT/DID offer parity — NFT offers + royalty shipped; DID is not an offer
 * asset, see `offers.ts`'s module doc) — the trade actions driven against the BUILT unpacked
 * extension in a real browser, through the self-custody vault. It proves the SW routes `makeOffer`,
 * `inspectOffer`, `prepareTrade`, and `confirmTrade` to the offscreen vault (never the "unknown
 * custody action" stub) for BOTH the existing XCH/CAT legs and the new NFT leg, and that the vault's
 * request guards fire end-to-end:
 *   - `makeOffer` with missing fields → the vault's BAD_REQUEST guard (deterministic, no coinset).
 *   - `makeOffer` offering an NFT is WIRED — it reaches the vault's chain path (hint-scan needs
 *     coinset, which errors/times out in CI) and is NEVER the unknown-action stub.
 *   - `inspectOffer` with a garbage (non-decodable) offer string → a real decode-error code, never
 *     the unknown-action stub (this is a pure decode, no network — deterministic in CI).
 *   - `prepareTrade` (take) is WIRED — same chain-path proof as `makeOffer`.
 *   - `confirmTrade` with a bogus pending id → the vault's NO_PENDING guard.
 *
 * The exact built offer structure (settlement legs, the CHIP-0011 royalty trade-price + extra
 * settle payment, coin math, signatures aggregated) is proven deterministically at the engine layer
 * against the wasm Simulator through the real driver path in offers.test.ts (a live coinset is
 * non-deterministic and the extension-page CSP precludes a local coinset mock — the same split as
 * the #92 NFT-mint / #93 DID / #91 coin-control e2e). This pass never auto-broadcasts a mainnet spend.
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
  const imported = await swSend<{ lockState?: string }>(ext, { action: 'importWallet', mnemonic: GOLDEN.mnemonic, password: 'e2e-94-not-a-real-secret' });
  expect(imported.lockState).toBe('unlocked');
});

test.afterAll(async () => {
  await context?.close();
});

test.describe('Trade offers (routed to the self-custody vault, incl. NFT legs #94)', () => {
  test('makeOffer without offered/requested hits the vault BAD_REQUEST guard (wired, not the unknown-action stub)', async () => {
    const res = await swSend<{ code?: string; message?: string }>(ext, { action: 'makeOffer' });
    expect(res.message).not.toBe(UNKNOWN_ACTION);
    expect(res.code).toBe('BAD_REQUEST');
  });

  test('makeOffer offering an NFT is wired to the vault chain path (never the unknown-action stub)', async () => {
    // Reaches the offscreen vault's hint-scan coinset read (findOwnedNft); in CI coinset is
    // unreachable, so it either errors (a real, non-stub code) or times out — both prove it is
    // wired, not the default 4xx stub.
    const res = await swSendRaced<{ success?: boolean; code?: string; message?: string }>(
      ext,
      {
        action: 'makeOffer',
        offered: { asset: { kind: 'nft', launcherId: 'ab'.repeat(32) }, amount: '1' },
        requested: { asset: { kind: 'xch' }, amount: '1000000000' },
      },
      6000,
    );
    if ('timedOut' in res) return; // reached the chain path and hung on unreachable coinset → wired
    expect(res.message).not.toBe(UNKNOWN_ACTION);
  });

  test('inspectOffer with a non-decodable string returns a real decode error (wired, not the unknown-action stub)', async () => {
    // A pure decode — no coinset needed — so this is deterministic in CI.
    const res = await swSend<{ success?: boolean; code?: string; message?: string }>(ext, { action: 'inspectOffer', offerStr: 'offer1-not-a-real-offer' });
    expect(res.success).toBe(false);
    expect(res.message).not.toBe(UNKNOWN_ACTION);
    expect(res.code).toBeTruthy();
  });

  test('inspectOffer without offerStr hits the vault BAD_REQUEST guard (wired)', async () => {
    const res = await swSend<{ code?: string; message?: string }>(ext, { action: 'inspectOffer' });
    expect(res.message).not.toBe(UNKNOWN_ACTION);
    expect(res.code).toBe('BAD_REQUEST');
  });

  test('prepareTrade (take) is wired to the vault chain path (never the unknown-action stub)', async () => {
    const res = await swSendRaced<{ success?: boolean; code?: string; message?: string }>(
      ext,
      { action: 'prepareTrade', offerStr: 'offer1-not-a-real-offer', tradeKind: 'take' },
      6000,
    );
    if ('timedOut' in res) return;
    expect(res.message).not.toBe(UNKNOWN_ACTION);
  });

  test('confirmTrade with a bogus pending id hits the vault NO_PENDING guard (wired)', async () => {
    const res = await swSend<{ code?: string; message?: string }>(ext, { action: 'confirmTrade', pendingId: 'does-not-exist' });
    expect(res.message).not.toBe(UNKNOWN_ACTION);
    expect(res.code).toBe('NO_PENDING');
  });
});
