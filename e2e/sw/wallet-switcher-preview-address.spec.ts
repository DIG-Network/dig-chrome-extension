import { test, expect, chromium, type BrowserContext, type Worker, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

/**
 * End-to-end proof for #176's `previewAddress` caching — the wallet switcher redesign's per-row
 * address preview. This is backend behavior added to `src/background/index.ts` (excluded from
 * vitest coverage — `@ts-nocheck` chrome.* runtime glue, validated here instead, same rationale as
 * every other case handler in that file), so it can ONLY be proven against the REAL built
 * extension's real SW + offscreen vault + `chrome.storage.local` — never a jsdom/mocked SW.
 *
 * Covers the acceptance bar:
 *   - a wallet's canonical (index-0) receive address gets cached onto its OWN registry entry the
 *     first time it's read while active, and `listWallets` reports it back out (#176's
 *     `WalletMeta.previewAddress`);
 *   - that cached preview SURVIVES switching away — `listWallets` still reports it for the
 *     now-inactive wallet, which is the whole point (showing an address for a wallet you are NOT
 *     currently in, without needing to unlock it);
 *   - it does NOT get overwritten by a non-zero active index's address (`shouldCachePreviewAddress`'s
 *     canonical-index-0-only rule) — switching to index 1 and reading the address must leave the
 *     wallet's cached preview at its index-0 value.
 *
 * Run: `npm run build && npm run test:sw`.
 */

const EXT_PATH = resolve(process.cwd(), 'dist');
const GOLDEN = JSON.parse(readFileSync(resolve(process.cwd(), 'src/lib/keystore/derive.golden.json'), 'utf8')) as {
  mnemonic: string;
  unhardened: { address: string }[];
};

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let extensionId: string;
let worker: Worker;
let ext: Page;

/** Send a chrome.runtime message from an extension page and resolve its reply. */
function swSend<T>(page: Page, message: Record<string, unknown>): Promise<T> {
  return page.evaluate((msg) => new Promise<T>((res) => chrome.runtime.sendMessage(msg, res as (r: unknown) => void)), message);
}

interface WalletMetaWire {
  id: string;
  label: string;
  active: boolean;
  activeIndex?: number;
  previewAddress?: string;
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

  // Wallet A: the golden fixture, deterministic address known up front.
  const imported = await swSend<{ lockState?: string; activeWalletId?: string }>(ext, {
    action: 'importWallet',
    mnemonic: GOLDEN.mnemonic,
    password: 'e2e-176-not-a-real-secret',
  });
  expect(imported.lockState).toBe('unlocked');
});

test.afterAll(async () => {
  await context?.close();
});

test.describe('#176 wallet switcher — previewAddress caching', () => {
  test('reading the active wallet\'s address (index 0) caches it as that wallet\'s previewAddress', async () => {
    // Read the receive address the way the UI does (CustodyWallet's home query) — this is what
    // opportunistically caches it (background/index.ts's getReceiveAddress case).
    const res = await swSend<{ address?: string }>(ext, { action: 'getReceiveAddress' });
    expect(res.address).toBe(GOLDEN.unhardened[0].address);

    const list = await swSend<{ wallets: WalletMetaWire[] }>(ext, { action: 'listWallets' });
    const walletA = list.wallets.find((w) => w.active);
    expect(walletA?.previewAddress).toBe(GOLDEN.unhardened[0].address);
  });

  test('a second wallet (fresh createWallet) gets its OWN previewAddress once read while active', async () => {
    const created = await swSend<{ lockState?: string; activeWalletId?: string }>(ext, {
      action: 'createWallet',
      password: 'e2e-176-second-wallet',
    });
    expect(created.lockState).toBe('unlocked');
    const walletBId = created.activeWalletId;
    expect(walletBId).toBeTruthy();

    const addrRes = await swSend<{ address?: string }>(ext, { action: 'getReceiveAddress' });
    expect(addrRes.address).toBeTruthy();
    expect(addrRes.address).not.toBe(GOLDEN.unhardened[0].address); // a different wallet, different key

    const list = await swSend<{ wallets: WalletMetaWire[] }>(ext, { action: 'listWallets' });
    const walletB = list.wallets.find((w) => w.id === walletBId);
    expect(walletB?.previewAddress).toBe(addrRes.address);

    // Wallet A's own cached preview is untouched by wallet B's activity.
    const walletA = list.wallets.find((w) => w.id !== walletBId);
    expect(walletA?.previewAddress).toBe(GOLDEN.unhardened[0].address);
  });

  test('switching away — the previewAddress SURVIVES for the now-inactive wallet (the whole point)', async () => {
    const before = await swSend<{ wallets: WalletMetaWire[] }>(ext, { action: 'listWallets' });
    const walletA = before.wallets.find((w) => w.previewAddress === GOLDEN.unhardened[0].address);
    expect(walletA).toBeTruthy();

    // Switch to wallet A (its key is already cached in the vault this session → instant).
    const switched = await swSend<{ lockState?: string; activeWalletId?: string }>(ext, {
      action: 'switchWallet',
      walletId: walletA!.id,
    });
    expect(switched.lockState).toBe('unlocked');

    // Wallet B (now inactive) still reports its own previewAddress from before — no unlock needed.
    const after = await swSend<{ wallets: WalletMetaWire[] }>(ext, { action: 'listWallets' });
    const walletBNow = after.wallets.find((w) => w.id !== walletA!.id);
    expect(walletBNow?.previewAddress).toBeTruthy();
    expect(walletBNow?.previewAddress).toBe(before.wallets.find((w) => w.id !== walletA!.id)?.previewAddress);
  });

  test('a non-zero active index does NOT overwrite the canonical index-0 previewAddress', async () => {
    // Wallet A is active (from the previous test). Navigate to index 1 and read its address.
    const setIdx = await swSend<{ success?: boolean; activeIndex?: number }>(ext, { action: 'setActiveIndex', index: 1 });
    expect(setIdx.success).toBe(true);

    const res = await swSend<{ address?: string }>(ext, { action: 'getReceiveAddress' });
    expect(res.address).toBe(GOLDEN.unhardened[1].address);
    expect(res.address).not.toBe(GOLDEN.unhardened[0].address);

    // previewAddress must still be the index-0 address — index 1's address never overwrote it.
    const list = await swSend<{ wallets: WalletMetaWire[] }>(ext, { action: 'listWallets' });
    const walletA = list.wallets.find((w) => w.activeIndex === 1);
    expect(walletA?.previewAddress).toBe(GOLDEN.unhardened[0].address);

    // Leave state clean for any test run after this one.
    await swSend(ext, { action: 'setActiveIndex', index: 0 });
  });
});
