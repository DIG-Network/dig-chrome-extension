import { test, expect, chromium, type BrowserContext, type Worker, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

/** The `listNfts` wire shape (mirrors `WalletNft`, `src/offscreen/nfts.ts`) — duplicated locally so
 * this e2e spec (outside `tsconfig.json`'s `include`, like its sibling specs) has no `@/` alias dep. */
interface MockNft {
  launcherId: string;
  coinId: string;
  p2PuzzleHash: string;
  collectionId: string | null;
  editionNumber: string;
  editionTotal: string;
  royaltyBasisPoints: number;
  royaltyPuzzleHash: string;
  dataUris: string[];
  dataHash: string | null;
  metadataUris: string[];
  metadataHash: string | null;
  licenseUris: string[];
}

/**
 * END-USER e2e for #171 (Collectibles multi-select bulk NFT transfer/burn) — driven against the BUILT
 * unpacked extension in a real (headless) browser, through the ACTUAL React selection UI on the
 * fullscreen Collectibles grid. Proves, end to end:
 *   - the popup surface NEVER offers selection mode (view-only, an "open full screen" link instead);
 *   - the fullscreen surface's "Select" control enters selection mode; tapping tiles toggles
 *     membership (not the detail view); select-all/clear + a live "N selected" count work; the
 *     Transfer/Burn action-bar buttons appear only once ≥1 NFT is selected;
 *   - a bulk TRANSFER completes a real UI journey — form → review (both selected NFTs listed) →
 *     confirm → sending → confirmed;
 *   - a bulk BURN is gated behind the DESTRUCTIVE type-to-confirm field (Review stays disabled until
 *     the literal `BURN` is typed) before completing warn → review → confirm → confirmed;
 *   - `confirmNftBulkTransfer`/`confirmNftBulkBurn` are NEVER sent before the user's own explicit
 *     confirm click (asserted via the SW-message spy) — no auto-broadcast.
 *
 * `listNfts` + the bulk prepare/confirm/poll actions are intercepted at the `chrome.runtime.
 * sendMessage` seam — exactly like nft-image-display.spec.ts's established pattern — because a real
 * bulk broadcast needs a live coinset + real minted NFTs (non-deterministic in CI, the same split as
 * every other vault e2e in this suite); this NEVER broadcasts a real mainnet spend. The real coin
 * math / signature-aggregation / burn-destination correctness is proven deterministically against the
 * wasm Simulator in `nfts.test.ts` + `vault.test.ts`.
 *
 * Run: `npm run build && npm run test:sw`.
 */

const EXT_PATH = resolve(process.cwd(), 'dist');
const GOLDEN = JSON.parse(readFileSync(resolve(process.cwd(), 'src/lib/keystore/derive.golden.json'), 'utf8')) as {
  mnemonic: string;
  unhardened: { address: string }[];
};
const PASSWORD = 'e2e-171-not-a-real-secret';
const RECIPIENT = GOLDEN.unhardened[0].address;

function nft(over: Partial<MockNft> & { launcherId: string }): MockNft {
  return {
    coinId: 'cd'.repeat(32),
    p2PuzzleHash: 'ef'.repeat(32),
    collectionId: null,
    editionNumber: '1',
    editionTotal: '1',
    royaltyBasisPoints: 0,
    royaltyPuzzleHash: '00'.repeat(32),
    dataUris: [],
    dataHash: null,
    metadataUris: [],
    metadataHash: null,
    licenseUris: [],
    ...over,
  };
}

const NFT_A = nft({ launcherId: 'aa'.repeat(32) });
const NFT_B = nft({ launcherId: 'bb'.repeat(32) });
const MOCK_NFTS = [NFT_A, NFT_B];
/** The well-known Chia burn puzzle hash (§171, `nfts.ts`'s `NFT_BURN_PUZZLE_HASH`) — 30 zero bytes + `dead`. */
const BURN_PUZZLE_HASH_HEX = `${'0'.repeat(60)}dead`;

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let extensionId: string;
let worker: Worker;
let ext: Page;

/** Send a chrome.runtime message from an extension page and resolve its reply. */
function swSend<T>(page: Page, message: Record<string, unknown>): Promise<T> {
  return page.evaluate((msg) => new Promise<T>((res) => chrome.runtime.sendMessage(msg, res as (r: unknown) => void)), message);
}

test.beforeAll(async () => {
  if (!existsSync(resolve(EXT_PATH, 'manifest.json'))) {
    throw new Error(`Built extension not found at ${EXT_PATH} — run \`npm run build\` before the e2e.`);
  }
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    args: ['--headless=new', `--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`],
  });

  // Intercept ONLY the Collectibles bulk-action SW actions, context-wide (every page, from its very
  // first script) — every other action (import/unlock, etc.) flows through to the real background
  // service worker untouched. Deterministic replies let this spec drive a REAL, full UI journey
  // (form → review → confirm → confirmed) without a live coinset or real minted NFTs. The wrapper also
  // records every action attempted on `window.__sentActions` (read by `sentActions()` below) so a test
  // can assert an approval-gated action was/was-not sent yet — tracked HERE (not a separate per-page
  // `page.evaluate` after `goto`) so installing the spy adds no extra round trip that could race the
  // headless `chrome.idle` auto-lock between navigation and the first UI assertion.
  await context.addInitScript(
    ({ nfts, burnPuzzleHashHex }) => {
      (window as unknown as { __sentActions: string[] }).__sentActions = [];
      const original = chrome.runtime.sendMessage.bind(chrome.runtime) as typeof chrome.runtime.sendMessage;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (chrome.runtime as any).sendMessage = (message: unknown, callback?: (r: unknown) => void) => {
        const m = message as { action?: string; launcherIds?: string[]; pendingId?: string };
        if (m?.action) (window as unknown as { __sentActions: string[] }).__sentActions.push(m.action);
        let reply: unknown;
        if (m && m.action === 'listNfts') {
          reply = { nfts, cached: false };
        } else if (m && m.action === 'prepareNftBulkTransfer') {
          reply = { pendingId: 'e2e-bulk-transfer-1', nftBulkSummary: { launcherIds: m.launcherIds, recipientPuzzleHashHex: 'ef', fee: '0', coinCount: (m.launcherIds ?? []).length, isBurn: false } };
        } else if (m && m.action === 'confirmNftBulkTransfer') {
          reply = { spentCoinId: 'e2e-bulk-transfer-coin' };
        } else if (m && m.action === 'prepareNftBulkBurn') {
          reply = { pendingId: 'e2e-bulk-burn-1', nftBulkSummary: { launcherIds: m.launcherIds, recipientPuzzleHashHex: burnPuzzleHashHex, fee: '0', coinCount: (m.launcherIds ?? []).length, isBurn: true } };
        } else if (m && m.action === 'confirmNftBulkBurn') {
          reply = { spentCoinId: 'e2e-bulk-burn-coin' };
        } else if (m && m.action === 'sendStatus') {
          reply = { confirmed: true };
        }
        if (reply !== undefined) {
          if (callback) {
            callback(reply);
            return;
          }
          return Promise.resolve(reply);
        }
        return (original as unknown as (...a: unknown[]) => unknown)(message, callback);
      };
    },
    { nfts: MOCK_NFTS, burnPuzzleHashHex: BURN_PUZZLE_HASH_HEX },
  );

  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extensionId = worker.url().split('/')[2];

  // A setup page imports the wallet into the shared offscreen vault, kept open for the whole suite
  // (mirrors nft-image-display.spec.ts — auto-lock fires on an all-windows-closed transition).
  ext = await context.newPage();
  await ext.goto(`chrome-extension://${extensionId}/popup.html`);
  const imported = await swSend<{ lockState?: string }>(ext, { action: 'importWallet', mnemonic: GOLDEN.mnemonic, password: PASSWORD });
  expect(imported.lockState).toBe('unlocked');
});

/** Re-unlock right before each UI check (mirrors nft-image-display.spec.ts — headless `chrome.idle`
 * can auto-lock the vault between tests with no real user input). */
async function ensureUnlocked(): Promise<void> {
  const res = await swSend<{ lockState?: string }>(ext, { action: 'unlockWallet', password: PASSWORD });
  expect(res.lockState).toBe('unlocked');
}

/** Read the per-page action log the `addInitScript` wrapper (above) records from page-load — lets a
 * test assert an approval-gated action was/was-not sent yet. */
function sentActions(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __sentActions: string[] }).__sentActions ?? []);
}

/**
 * Navigate to an extension page and land on the UNLOCKED Collectibles grid, deterministically —
 * `ensureUnlocked()` closes the race window that exists BEFORE this call, but under system load
 * (e.g. running the whole `e2e/sw` suite back to back, ~1.5 minutes of real wall-clock in one
 * headless browser) `chrome.idle`'s real-time detection can still fire WHILE this navigation is in
 * flight, landing on `custody-unlock` instead of the grid. Recover deterministically instead of
 * flaking: re-unlock + reload once if that happens.
 */
async function gotoCollectiblesUnlocked(page: Page, path: string): Promise<void> {
  await page.goto(`chrome-extension://${extensionId}/${path}`);
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!(await page.getByTestId('custody-unlock').isVisible({ timeout: 3000 }).catch(() => false))) break;
    await ensureUnlocked();
    await page.reload();
  }
  await expect(page.getByTestId('nft-grid')).toBeVisible();
}

test.afterAll(async () => {
  await context?.close();
});

test.describe('Collectibles multi-select bulk transfer/burn (#171)', () => {
  test('the popup surface never enters selection mode — an "open full screen" link instead', async () => {
    await ensureUnlocked();
    const page = await context.newPage();
    await page.setViewportSize({ width: 390, height: 700 });
    await gotoCollectiblesUnlocked(page, 'popup.html#wallet/collectibles');
    await expect(page.getByTestId('collectibles-select-enter')).toHaveCount(0);
    await expect(page.getByTestId('collectibles-bulk-fullscreen')).toBeVisible();
    await page.getByTestId('collectibles-panel').screenshot({ path: 'test-results/nft-bulk-popup-viewonly.png' });
  });

  test('select multiple NFTs on the fullscreen grid and complete a bulk transfer', async () => {
    await ensureUnlocked();
    const page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 800 });
    await gotoCollectiblesUnlocked(page, 'app.html#wallet/collectibles');
    await page.getByTestId('collectibles-select-enter').click();
    await expect(page.getByTestId('collectibles-selection-bar')).toContainText('0 selected');

    // Selecting a tile toggles membership — it must NOT open the detail view.
    await page.getByTestId(`nft-tile-${NFT_A.launcherId}`).click();
    await expect(page.getByTestId('nft-detail')).toHaveCount(0);
    await expect(page.getByTestId('collectibles-selection-bar')).toContainText('1 selected');
    await page.getByTestId(`nft-tile-${NFT_B.launcherId}`).click();
    await expect(page.getByTestId('collectibles-selection-bar')).toContainText('2 selected');
    await page.getByTestId('collectibles-panel').screenshot({ path: 'test-results/nft-bulk-selection-bar.png' });

    await page.getByTestId('collectibles-selection-transfer').click();
    await expect(page.getByTestId('bulk-nft-transfer')).toBeVisible();
    await expect(page.getByTestId('bulk-transfer-form')).toContainText('Transfer 2 NFTs');

    await page.getByTestId('bulk-transfer-recipient').fill(RECIPIENT);
    await page.getByTestId('bulk-transfer-review').click();
    await expect(page.getByTestId('bulk-transfer-review-panel')).toBeVisible();
    await expect(page.getByTestId('bulk-transfer-review-list')).toContainText(NFT_A.launcherId.slice(0, 6));
    await expect(page.getByTestId('bulk-transfer-review-list')).toContainText(NFT_B.launcherId.slice(0, 6));
    expect(await sentActions(page)).not.toContain('confirmNftBulkTransfer'); // not yet — approval pending

    await page.screenshot({ path: 'test-results/nft-bulk-transfer-review.png' });

    await page.getByTestId('bulk-transfer-confirm').click();
    await expect(page.getByTestId('bulk-transfer-confirmed')).toBeVisible();
    expect(await sentActions(page)).toContain('prepareNftBulkTransfer');
    expect(await sentActions(page)).toContain('confirmNftBulkTransfer');

    await page.screenshot({ path: 'test-results/nft-bulk-transfer-confirmed.png' });
  });

  test('select an NFT and complete a destructive burn gated by type-to-confirm', async () => {
    await ensureUnlocked();
    const page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 800 });
    await gotoCollectiblesUnlocked(page, 'app.html#wallet/collectibles');
    await page.getByTestId('collectibles-select-enter').click();
    await page.getByTestId('collectibles-select-all').click();
    await expect(page.getByTestId('collectibles-selection-bar')).toContainText('2 selected');
    // Deselect down to one NFT for this burn.
    await page.getByTestId(`nft-tile-${NFT_B.launcherId}`).click();
    await expect(page.getByTestId('collectibles-selection-bar')).toContainText('1 selected');

    await page.getByTestId('collectibles-selection-burn').click();
    await expect(page.getByTestId('bulk-nft-burn')).toBeVisible();
    await expect(page.getByTestId('bulk-burn-warning')).toContainText('permanent and cannot be undone');
    await expect(page.getByTestId('bulk-burn-review')).toBeDisabled();

    await page.screenshot({ path: 'test-results/nft-bulk-burn-warning.png' });

    // Review stays locked until the literal BURN is typed — never reachable via a stray click.
    await page.getByTestId('bulk-burn-confirm-text').fill('not it');
    await expect(page.getByTestId('bulk-burn-confirm-mismatch')).toBeVisible();
    await expect(page.getByTestId('bulk-burn-review')).toBeDisabled();

    await page.getByTestId('bulk-burn-confirm-text').fill('BURN');
    await expect(page.getByTestId('bulk-burn-review')).toBeEnabled();
    await page.getByTestId('bulk-burn-review').click();

    await expect(page.getByTestId('bulk-burn-review-panel')).toBeVisible();
    await expect(page.getByTestId('bulk-burn-review-destination')).toContainText('unspendable');
    expect(await sentActions(page)).not.toContain('confirmNftBulkBurn'); // not yet — approval pending

    await page.screenshot({ path: 'test-results/nft-bulk-burn-review.png' });

    await page.getByTestId('bulk-burn-confirm').click();
    await expect(page.getByTestId('bulk-burn-confirmed')).toBeVisible();
    expect(await sentActions(page)).toContain('prepareNftBulkBurn');
    expect(await sentActions(page)).toContain('confirmNftBulkBurn'); // only fired AFTER the explicit confirm click

    await page.screenshot({ path: 'test-results/nft-bulk-burn-confirmed.png' });
  });
});
