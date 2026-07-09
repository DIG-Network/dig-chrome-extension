import { test, expect, chromium, type BrowserContext, type Worker, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

/**
 * END-USER e2e for #168 (background prefetch: the SW warms balances/assets/collectibles/activity on
 * unlock, not lazily on nav). Driven against the BUILT unpacked extension in a real (headless)
 * browser, through the REAL React shell (`Shell` in `App.tsx`) and the real `useBackgroundPrefetch`
 * hook — proving the CLIENT-side orchestration end to end:
 *
 *   - opening an already-unlocked page fires `listNfts` (the Collectibles data source) WITHOUT ever
 *     navigating to the Collectibles tab — the whole point of #168 (not lazy on nav);
 *   - navigating TO Collectibles afterward renders the already-warmed data with NO additional
 *     `listNfts` call (the RTK Query cache is shared between the prefetch dispatch and the view's
 *     own hook — proven at the message-count level, the same technique
 *     `nft-image-lightbox.spec.ts` uses for asserting "the same cached src — no re-fetch");
 *   - switching the active derivation index (#165) via the real `IndexNavigator` UI re-fires a fresh
 *     `listNfts` round for the new context (re-prefetch on switch).
 *
 * `chrome.runtime.sendMessage` is intercepted (same technique as `nft-image-lightbox.spec.ts`) to
 * simulate a fully unlocked wallet with a counting mock — this spec is about the CLIENT prefetch
 * orchestration, not chain-read correctness (that is covered by `wallet-balances.spec.ts` /
 * `activity-log.spec.ts` against live coinset, and by the unit-level cancellation/no-stale-write
 * proof in `src/app/useBackgroundPrefetch.test.tsx`). No real keystore, no live coinset, no mnemonic.
 *
 * Run: `npm run build && npm run test:sw`.
 */

const EXT_PATH = resolve(process.cwd(), 'dist');

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let extensionId: string;
let worker: Worker;

test.beforeAll(async () => {
  if (!existsSync(resolve(EXT_PATH, 'manifest.json'))) {
    throw new Error(`Built extension not found at ${EXT_PATH} — run \`npm run build\` before the e2e.`);
  }
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    args: ['--headless=new', `--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`],
  });

  // Simulate a fully-unlocked, single-wallet session entirely at the SW-message seam, on every
  // extension page in this context — no real keystore, no live coinset. `setActiveIndex` mutates the
  // shared `activeIndex` so a later `getLockState` reports the switched context, exactly like the
  // real SW registry op (§18.1a). Every call is counted by action so a test can assert "no NEW call"
  // vs. "a fresh round fired".
  await context.addInitScript(() => {
    const mock = { activeIndex: 0, calls: {} as Record<string, number> };
    (window as unknown as { __e2e168: typeof mock }).__e2e168 = mock;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (chrome.runtime as any).sendMessage = (message: unknown, callback?: (r: unknown) => void) => {
      const m = message as { action?: string; index?: number };
      const action = m?.action ?? 'unknown';
      mock.calls[action] = (mock.calls[action] ?? 0) + 1;

      let reply: unknown;
      switch (action) {
        case 'getLockState':
          reply = { lockState: 'unlocked', activeWalletId: 'e2e-168', activeIndex: mock.activeIndex };
          break;
        case 'getCustodyBalances':
          reply = { balances: { xch: 1_000_000_000_000, cats: {} } };
          break;
        case 'getActivity':
          reply = { events: [] };
          break;
        case 'getReceiveAddress':
          reply = { address: 'xch1e2e168qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqzzzz' };
          break;
        case 'listClawbacks':
          reply = { clawbacks: [] };
          break;
        case 'listNfts':
          reply = { nfts: [] };
          break;
        case 'setActiveIndex':
          mock.activeIndex = typeof m.index === 'number' ? m.index : mock.activeIndex;
          reply = { success: true, activeIndex: mock.activeIndex };
          break;
        default:
          reply = { success: true };
      }
      if (callback) {
        callback(reply);
        return undefined;
      }
      return Promise.resolve(reply);
    };
  });

  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extensionId = worker.url().split('/')[2];
});

test.afterAll(async () => {
  await context?.close();
});

/** Read the mocked SW's call count for one action, from inside the page. */
function callCount(page: Page, action: string): Promise<number> {
  return page.evaluate(
    (a) => (window as unknown as { __e2e168: { calls: Record<string, number> } }).__e2e168.calls[a] ?? 0,
    action,
  );
}

test.describe('Background prefetch on unlock (#168)', () => {
  test('opening an already-unlocked page prefetches Collectibles data without visiting the tab; navigating to it fires no new call', async () => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/app.html`);

    // The shell mounts `useBackgroundPrefetch` regardless of tab (default landing is Home, #2.1) —
    // `listNfts` must fire on its own, with NO Collectibles UI ever opened.
    await expect.poll(() => callCount(page, 'listNfts')).toBeGreaterThanOrEqual(1);
    const afterUnlock = await callCount(page, 'listNfts');

    // Now navigate to Collectibles via the real UI. app.html at the default (wide) viewport renders
    // the desktop workspace (#85), whose sidebar IS the wallet-view nav — one click routes there.
    await page.getByTestId('nav-collectibles').click();
    await expect(page.getByTestId('collectibles-panel')).toBeVisible();

    // Rendered from the already-warmed cache — no additional `listNfts` round-trip on nav.
    expect(await callCount(page, 'listNfts')).toBe(afterUnlock);
  });

  test('switching the active derivation index re-fires a fresh prefetch round', async () => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/app.html#wallet`);
    await page.getByTestId('custody-wallet').waitFor();

    await expect.poll(() => callCount(page, 'listNfts')).toBeGreaterThanOrEqual(1);
    const beforeSwitch = await callCount(page, 'listNfts');

    await page.getByTestId('index-nav-next').click();
    await expect(page.getByTestId('index-nav-current')).toContainText('1');

    // A fresh round fires for the new (wallet, index=1) context — #165 single-index re-prefetch.
    await expect.poll(() => callCount(page, 'listNfts')).toBeGreaterThan(beforeSwitch);
  });
});
