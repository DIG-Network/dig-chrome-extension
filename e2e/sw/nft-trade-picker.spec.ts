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
 * END-USER e2e for #170 (NFT trade — XL modal NFT-selection picker) — driven against the BUILT
 * unpacked extension in a real (headless) browser, through the ACTUAL React trade UI on the
 * fullscreen Trade panel. Proves, end to end:
 *   - choosing "NFT" as the give-kind and clicking "Select NFT" opens the XL modal picker
 *     (`nft-picker-modal`) showing a grid of the wallet's NFTs;
 *   - search narrows the grid to a matching NFT;
 *   - picking a tile + "Add N selected" closes the modal and shows the chosen NFT on the trade form;
 *   - "Change" reopens the picker pre-selecting the current pick, and picking a different tile
 *     REPLACES it (single-offered-asset v1 model, §18.10) rather than adding a second NFT;
 *   - completing the guided flow (continue → review → confirm) builds the offer with the chosen
 *     NFT as the offered leg and shows the shareable deal card.
 *
 * `listNfts` and `makeOffer` are intercepted at the `chrome.runtime.sendMessage` seam — exactly like
 * `nft-bulk-actions.spec.ts`'s established pattern — because a real offer build needs a live coinset
 * hint-scan (non-deterministic in CI); this NEVER broadcasts a real mainnet spend. The exact built
 * offer structure (settlement legs, royalty) is proven deterministically against the wasm Simulator
 * in `offers.test.ts`.
 *
 * Run: `npm run build && npm run test:sw`.
 */

const EXT_PATH = resolve(process.cwd(), 'dist');
const GOLDEN = JSON.parse(readFileSync(resolve(process.cwd(), 'src/lib/keystore/derive.golden.json'), 'utf8')) as { mnemonic: string };
const PASSWORD = 'e2e-170-not-a-real-secret';

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
const OFFER = 'offer1qqqe2e170examplefakeofferqqq';

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

  // Intercept ONLY the Collectibles read + makeOffer SW actions, context-wide (every page, from its
  // very first script) — every other action (import/unlock, balances, etc.) flows through to the
  // real background service worker untouched, exactly like nft-bulk-actions.spec.ts.
  await context.addInitScript(
    ({ nfts, offer }) => {
      (window as unknown as { __sentActions: string[] }).__sentActions = [];
      const original = chrome.runtime.sendMessage.bind(chrome.runtime) as typeof chrome.runtime.sendMessage;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (chrome.runtime as any).sendMessage = (message: unknown, callback?: (r: unknown) => void) => {
        const m = message as { action?: string; offered?: unknown };
        if (m?.action) (window as unknown as { __sentActions: string[] }).__sentActions.push(m.action);
        let reply: unknown;
        if (m && m.action === 'listNfts') {
          reply = { nfts, cached: false };
        } else if (m && m.action === 'makeOffer') {
          reply = {
            offer,
            offerSummary: {
              offered: [m.offered],
              requested: [{ asset: { kind: 'xch' }, amount: '1000000000', toPuzzleHashHex: 'ab' }],
            },
          };
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
    { nfts: MOCK_NFTS, offer: OFFER },
  );

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

/** Re-unlock right before each UI check (headless `chrome.idle` can auto-lock the vault between
 * tests with no real user input — same rationale as nft-bulk-actions.spec.ts). */
async function ensureUnlocked(): Promise<void> {
  const res = await swSend<{ lockState?: string }>(ext, { action: 'unlockWallet', password: PASSWORD });
  expect(res.lockState).toBe('unlocked');
}

/** Navigate to the fullscreen Trade panel, recovering from a headless auto-lock race deterministically
 * instead of flaking (mirrors nft-bulk-actions.spec.ts's `gotoCollectiblesUnlocked`). */
async function gotoTradeUnlocked(page: Page): Promise<void> {
  await page.goto(`chrome-extension://${extensionId}/app.html#wallet/trade`);
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!(await page.getByTestId('custody-unlock').isVisible({ timeout: 3000 }).catch(() => false))) break;
    await ensureUnlocked();
    await page.reload();
  }
  await expect(page.getByTestId('trade-mode-make')).toBeVisible();
}

test.describe('NFT-trade picker — XL modal (#170)', () => {
  test('opens the XL modal, selects an NFT via search, and it flows into the trade + deal card', async () => {
    await ensureUnlocked();
    const page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 800 });
    await gotoTradeUnlocked(page);

    await page.getByTestId('trade-give-kind-nft').click();
    await page.getByTestId('trade-give-nft-select').click();
    await expect(page.getByTestId('nft-picker-modal')).toBeVisible();
    await expect(page.getByTestId(`nft-tile-${NFT_A.launcherId}`)).toBeVisible();
    await expect(page.getByTestId(`nft-tile-${NFT_B.launcherId}`)).toBeVisible();

    // search narrows the grid to NFT_A only
    await page.getByTestId('nft-picker-search').fill(NFT_A.launcherId.slice(0, 8));
    await expect(page.getByTestId(`nft-tile-${NFT_A.launcherId}`)).toBeVisible();
    await expect(page.getByTestId(`nft-tile-${NFT_B.launcherId}`)).toHaveCount(0);
    await page.screenshot({ path: 'test-results/nft-trade-picker-search.png' });

    await page.getByTestId(`nft-tile-${NFT_A.launcherId}`).click();
    await expect(page.getByTestId('nft-picker-count')).toContainText('1 selected');
    await page.getByTestId('nft-picker-confirm').click();

    await expect(page.getByTestId('nft-picker-modal')).toHaveCount(0);
    await expect(page.getByTestId('trade-give-nft-chosen')).toBeVisible();
    await page.screenshot({ path: 'test-results/nft-trade-picker-chosen.png' });

    // "Change" reopens the picker pre-selecting NFT_A; picking NFT_B REPLACES it (not a 2nd NFT).
    await page.getByTestId('trade-give-nft-change').click();
    await expect(page.getByTestId('nft-picker-count')).toContainText('1 selected');
    await page.getByTestId(`nft-tile-${NFT_B.launcherId}`).click();
    await expect(page.getByTestId('nft-picker-count')).toContainText('1 selected'); // still one, replaced
    await page.getByTestId('nft-picker-confirm').click();

    await page.getByTestId('trade-get-amount').fill('1');
    await page.getByTestId('trade-make-continue').click();
    await expect(page.getByTestId('trade-make-review')).toBeVisible();
    await page.getByTestId('trade-make-review-confirm').click();

    await expect(page.getByTestId('trade-deal-card')).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __sentActions: string[] }).__sentActions)).toContain('makeOffer');
    await page.screenshot({ path: 'test-results/nft-trade-picker-deal-card.png' });
  });

  test('Cancel closes the picker without changing the current pick (mobile viewport — full-screen sheet)', async () => {
    await ensureUnlocked();
    const page = await context.newPage();
    await page.setViewportSize({ width: 390, height: 700 });
    await gotoTradeUnlocked(page);

    await page.getByTestId('trade-give-kind-nft').click();
    await page.getByTestId('trade-give-nft-select').click();
    await expect(page.getByTestId('nft-picker-modal')).toBeVisible();
    await page.screenshot({ path: 'test-results/nft-trade-picker-mobile.png' });

    await page.getByTestId(`nft-tile-${NFT_A.launcherId}`).click();
    await page.getByTestId('nft-picker-cancel').click();
    await expect(page.getByTestId('nft-picker-modal')).toHaveCount(0);
    await expect(page.getByTestId('trade-give-nft-select')).toBeVisible(); // nothing chosen — cancel discarded the pick
  });
});
