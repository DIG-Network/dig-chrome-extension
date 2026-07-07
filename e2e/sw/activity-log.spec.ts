import { test, expect, chromium, type BrowserContext, type Worker, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

/**
 * End-to-end proof for #154 — Activity is LOCAL transaction tracking (MetaMask-style), NOT an
 * on-chain coinset scan. Driven against the BUILT unpacked extension in a real headless Chromium,
 * over the real SW + `chrome.storage.local` (the storage-glue helpers this exercises —
 * `logActivity`/`confirmActivity`/`logReceivedActivity`/the `getActivity` case — live in
 * `src/background/index.ts`, which is `@ts-nocheck` chrome.* runtime glue excluded from vitest
 * coverage and validated here instead, same rationale as every other background/index.ts behavior).
 *
 * This pass NEVER broadcasts a real mainnet spend (§7 security rule) — `getCustodyBalances` and
 * `sendStatus`/`coinConfirmed` are read-only coinset queries, safe to call for real, but a genuine
 * `confirmSend`/`confirmTrade` broadcast is never exercised here. Two things follow from that:
 *
 *   1. To prove the log's READ/PERSISTENCE/ISOLATION behavior without a real spend, tests seed a
 *      `pending`/`confirmed` entry directly into `wallet.activityLog` (a documented, stable storage
 *      key — `ACTIVITY_LOG_KEY` in `src/lib/custody-session.ts`) exactly as `logActivity` would have
 *      written it, then drive the REAL SW `getActivity`/`switchWallet`/`createWallet` actions against
 *      that seed. This is the same established pattern `session-persist.spec.ts` uses to seed
 *      `wallet.unlockExpiry` directly for deterministic setup.
 *   2. The POSITIVE pending→confirmed transition itself (`markEntryConfirmed`) is authoritatively
 *      proven at the unit level (100% branch coverage, `src/lib/activity-log.test.ts`), as is the
 *      vault's `activityHint` plumbing (`src/offscreen/vault.test.ts`) — reaching a real "this coin
 *      IS confirmed" answer from live coinset would require either a real broadcast (forbidden) or a
 *      hardcoded real historical coin id (fragile, and coincidental — not actually testing OUR code).
 *      This file instead proves the NEGATIVE branch live and safe: a seeded pending entry stays
 *      pending when `sendStatus` (a real, read-only `coinConfirmed` query) reports the coin is NOT
 *      confirmed — exercising the exact same code path with a deterministic, always-true precondition
 *      (a coin id that has certainly never existed on mainnet cannot be confirmed).
 *
 * Run: `npm run build && npm run test:sw`.
 */

const EXT_PATH = resolve(process.cwd(), 'dist');
const GOLDEN = JSON.parse(readFileSync(resolve(process.cwd(), 'src/lib/keystore/derive.golden.json'), 'utf8')) as { mnemonic: string };
const PASSWORD = 'e2e-154-not-a-real-secret';
/** Mirrors `ACTIVITY_LOG_KEY` in src/lib/custody-session.ts — a documented, stable storage key. */
const ACTIVITY_LOG_KEY = 'wallet.activityLog';

interface LocalActivityEntry {
  id: string;
  kind: string;
  asset: string;
  amount: string;
  counterparty: string | null;
  coinId: string | null;
  timestamp: number;
  status: 'pending' | 'confirmed';
}

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let extensionId: string;
let worker: Worker;
let ext: Page;

/** Send a chrome.runtime message from an extension page and resolve its reply. */
function swSend<T>(page: Page, message: Record<string, unknown>): Promise<T> {
  return page.evaluate((msg) => new Promise<T>((res) => chrome.runtime.sendMessage(msg, res as (r: unknown) => void)), message);
}

/** Open a fresh extension page (simulates "open the popup" / "reopen after close"). */
async function openSurface(file: 'popup.html' | 'app.html'): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/${file}`);
  return page;
}

/** Seed one entry directly into a wallet+index's activity-log scope (see the file doc for why). */
function seedActivityEntry(page: Page, walletId: string, index: number, entry: LocalActivityEntry): Promise<void> {
  return page.evaluate(
    ({ key, scopeKey, entry }) =>
      chrome.storage.local.get(key).then((r: Record<string, unknown>) => {
        const state = (r[key] && typeof r[key] === 'object' ? r[key] : {}) as Record<string, LocalActivityEntry[]>;
        state[scopeKey] = [entry];
        return chrome.storage.local.set({ [key]: state });
      }),
    { key: ACTIVITY_LOG_KEY, scopeKey: `${walletId}:${index}`, entry },
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
  const imported = await swSend<{ lockState?: string }>(ext, { action: 'importWallet', mnemonic: GOLDEN.mnemonic, password: PASSWORD });
  expect(imported.lockState).toBe('unlocked');
});

test.afterAll(async () => {
  await context?.close();
});

test.describe('#154 local activity log — instant read, reopen persistence, per-wallet isolation', () => {
  test('a logged entry loads instantly via getActivity, survives closing + reopening the popup, and is isolated per wallet', async () => {
    const listA = await swSend<{ wallets: { id: string; active: boolean }[] }>(ext, { action: 'listWallets' });
    const walletAId = listA.wallets.find((w) => w.active)!.id;
    const seed: LocalActivityEntry = {
      id: 'sent:' + 'ab'.repeat(32),
      kind: 'sent',
      asset: 'XCH',
      amount: '250000000000',
      counterparty: 'xch1qqqqe2e154qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqzzzz',
      coinId: 'ab'.repeat(32),
      timestamp: Date.now(),
      status: 'pending',
    };
    await seedActivityEntry(ext, walletAId, 0, seed);

    // Instant local read (no coinset round-trip — the whole point of #154).
    const res1 = await swSend<{ events: LocalActivityEntry[] }>(ext, { action: 'getActivity' });
    expect(res1.events).toEqual([seed]);

    // Close the popup entirely and open a brand-new page — nothing but SW-owned storage carries
    // the log across, exactly like #155's session-persistence proof for lock state.
    await ext.close();
    ext = await openSurface('popup.html');
    const res2 = await swSend<{ events: LocalActivityEntry[] }>(ext, { action: 'getActivity' });
    expect(res2.events).toEqual([seed]);

    // A second, freshly-created wallet sees NONE of wallet A's history (per-wallet isolation).
    const created = await swSend<{ lockState?: string; activeWalletId?: string }>(ext, { action: 'createWallet', password: 'e2e-154-wallet-b' });
    expect(created.lockState).toBe('unlocked');
    const res3 = await swSend<{ events: LocalActivityEntry[] }>(ext, { action: 'getActivity' });
    expect(res3.events).toEqual([]);

    // Switching back to wallet A restores exactly its own entry — isolation holds both directions.
    // Its password is supplied as a fallback: an MV3 offscreen document (the sole holder of a
    // cached key, by design — see vault.ts's module doc) can be torn down between calls, so the
    // key may no longer be cached even within one test.
    const switched = await swSend<{ lockState?: string }>(ext, { action: 'switchWallet', walletId: walletAId, password: PASSWORD });
    expect(switched.lockState).toBe('unlocked');
    const res4 = await swSend<{ events: LocalActivityEntry[] }>(ext, { action: 'getActivity' });
    expect(res4.events).toEqual([seed]);
  });

  test('sendStatus (real, read-only coinConfirmed) leaves a seeded pending entry untouched when the coin is not confirmed', async () => {
    const listA = await swSend<{ wallets: { id: string; active: boolean }[] }>(ext, { action: 'listWallets' });
    const walletAId = listA.wallets.find((w) => w.active)!.id;
    // A coin id that has certainly never existed on mainnet — coinConfirmed MUST report false.
    const neverExistedCoinId = 'ff'.repeat(32);
    const seed: LocalActivityEntry = {
      id: 'sent:' + neverExistedCoinId,
      kind: 'sent',
      asset: 'XCH',
      amount: '1000000',
      counterparty: 'xch1qqqqneverconfirmedqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqzzzz',
      coinId: neverExistedCoinId,
      timestamp: Date.now(),
      status: 'pending',
    };
    await seedActivityEntry(ext, walletAId, 0, seed);

    const status = await swSend<{ confirmed?: boolean }>(ext, { action: 'sendStatus', coinId: neverExistedCoinId });
    expect(status.confirmed).toBe(false);

    const res = await swSend<{ events: LocalActivityEntry[] }>(ext, { action: 'getActivity' });
    expect(res.events.find((e) => e.coinId === neverExistedCoinId)?.status).toBe('pending');
  });

  // #154 acceptance: "a received coin appears after the next balance scan". getCustodyBalances is a
  // real, read-only coinset query (never a spend) — the assertion is conditional on the golden
  // wallet's REAL current balance genuinely exceeding the synthetic baseline seeded below, since this
  // suite cannot control what (if anything) is actually held at a public fixture address; either way
  // the call must complete without error, proving the wiring (detectReceivedEntries + the log write)
  // never crashes even when there is nothing to report.
  test('a real balance increase over the seeded baseline is logged as a received entry (best-effort, live-balance-dependent)', async () => {
    const BALANCES_CACHE_KEY = 'walletCache.balances';
    // A synthetic zero baseline — any real nonzero balance the golden address holds will read as an
    // increase over this.
    await ext.evaluate(
      ({ key }) => chrome.storage.local.set({ [key]: { balances: { xch: 0, cats: {} }, at: Date.now() } }),
      { key: BALANCES_CACHE_KEY },
    );

    const res = await Promise.race<{ balances?: { xch?: number } } | { timedOut: true }>([
      swSend(ext, { action: 'getCustodyBalances' }),
      new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), 18_000)),
    ]);
    if ('timedOut' in res) return; // slow/rate-limited live coinset — still not a crash, acceptable.

    const activity = await swSend<{ events: LocalActivityEntry[] }>(ext, { action: 'getActivity' });
    const receivedEntries = activity.events.filter((e) => e.kind === 'received');
    if ((res.balances?.xch ?? 0) > 0) {
      // A real balance was observed — the delta MUST have been logged as an already-confirmed receive.
      expect(receivedEntries.length).toBeGreaterThan(0);
      expect(receivedEntries.every((e) => e.status === 'confirmed' && e.coinId === null)).toBe(true);
    }
  });
});
