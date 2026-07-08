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
 * END-USER e2e for #98 (NFT collection metadata + richer gallery) — proves, against the BUILT
 * unpacked extension in a real (headless) browser, the load-bearing architectural claim this
 * feature depends on: that the background SERVICE WORKER's `getNftMetadata` handler
 * (`src/background/index.ts`) can `fetch()` an ARBITRARY off-chain host — an IPFS gateway, a
 * marketplace CDN, anything a `metadataUri` might name — that is NOT individually enumerable in
 * advance.
 *
 * **A real, empirically-discovered gotcha (see `DEVELOPMENT_LOG.md`):** it was assumed while
 * designing this feature that a Manifest V3 background SERVICE WORKER's own `fetch()` is not
 * subject to the `content_security_policy.extension_pages` CSP directive (that directive's name
 * suggests it governs only extension HTML documents — popup/options/offscreen). This spec's FIRST
 * version proved that assumption WRONG in this real Chromium build: a `getNftMetadata` call to a
 * host outside the CSP `connect-src` allowlist failed with `NETWORK_ERROR` ("Failed to fetch") and
 * the mocked `context.route()` handler was never even invoked — i.e. the fetch never left the
 * browser, the exact signature of a CSP block, not a CORS failure (which would still hit the
 * network). `connect-src` (and `host_permissions`, for the extension's CORS-bypass fetch
 * elevation) had to be widened to `https:` / an all-hosts pattern (manifest.json) — matching the breadth
 * `img-src` already grants NFT art (§18.11) — before the SAME test passed. `getNftMetadata` is NOT
 * intercepted at the `chrome.runtime.sendMessage` seam here (unlike `listNfts`, mocked below) — it
 * flows through to the REAL background handler, which makes a REAL `fetch()` intercepted only at
 * the network layer (`context.route`), so a CSP/permission regression would surface as a genuine
 * failure here, not something a message-layer mock could paper over.
 *
 * Also proves the richer-gallery UI wiring end to end: the resolved off-chain name renders in the
 * grid tile, and the resolved collection name + description + attributes render in the detail view.
 *
 * Run: `npm run build && npm run test:sw`.
 */

const EXT_PATH = resolve(process.cwd(), 'dist');
const GOLDEN = JSON.parse(readFileSync(resolve(process.cwd(), 'src/lib/keystore/derive.golden.json'), 'utf8')) as { mnemonic: string };

// An arbitrary host with NO Access-Control-Allow-Origin header on its response — proving the
// extension's host_permissions elevation (not ordinary CORS) is what makes this fetch succeed,
// exactly like a real IPFS gateway or marketplace CDN metadata host would be reached.
const METADATA_URL = 'https://arbitrary-marketplace-e2e-98.example.test/meta.json';
const METADATA_DOC = {
  format: 'CHIP-0007',
  name: 'Cool Cat #1',
  description: 'A very cool cat, e2e-98 fixture.',
  attributes: [{ trait_type: 'Eyes', value: 'Green' }],
  collection: { id: 'col-e2e-98', name: 'Cool Cats Club' },
};
const PASSWORD = 'e2e-98-not-a-real-secret';

let metadataFetchCount = 0;

function nft(over: Partial<MockNft> & { launcherId: string }): MockNft {
  return {
    coinId: 'cd'.repeat(32),
    p2PuzzleHash: 'ef'.repeat(32),
    collectionId: 'col-e2e-98-did'.padEnd(64, '0'),
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

const NFT_WITH_METADATA = nft({ launcherId: 'aa'.repeat(32), metadataUris: [METADATA_URL] });
const MOCK_NFTS = [NFT_WITH_METADATA];

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

  // The REAL off-chain metadata fetch target — intercepted at the network layer only, with NO CORS
  // header, so a plain (non-elevated) cross-origin fetch would fail here too. If either the CSP
  // connect-src widening or the host_permissions elevation regressed, this handler would simply
  // never be invoked and the getNftMetadata response would be a NETWORK_ERROR instead.
  await context.route(METADATA_URL, (route) => {
    metadataFetchCount += 1;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(METADATA_DOC) });
  });

  // Intercept ONLY listNfts — getNftMetadata deliberately flows through to the REAL SW handler.
  await context.addInitScript((nfts) => {
    const original = chrome.runtime.sendMessage.bind(chrome.runtime) as typeof chrome.runtime.sendMessage;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (chrome.runtime as any).sendMessage = (message: unknown, callback?: (r: unknown) => void) => {
      const m = message as { action?: string };
      if (m && m.action === 'listNfts') {
        const reply = { nfts, cached: false };
        if (callback) {
          callback(reply);
          return;
        }
        return Promise.resolve(reply);
      }
      return (original as unknown as (...a: unknown[]) => unknown)(message, callback);
    };
  }, MOCK_NFTS);

  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extensionId = worker.url().split('/')[2];

  ext = await context.newPage();
  await ext.goto(`chrome-extension://${extensionId}/popup.html`);
  const imported = await swSend<{ lockState?: string }>(ext, { action: 'importWallet', mnemonic: GOLDEN.mnemonic, password: PASSWORD });
  expect(imported.lockState).toBe('unlocked');
});

async function ensureUnlocked(): Promise<void> {
  const res = await swSend<{ lockState?: string }>(ext, { action: 'unlockWallet', password: PASSWORD });
  expect(res.lockState).toBe('unlocked');
}

/** Navigate to the fullscreen Collectibles grid, recovering from a headless auto-lock race
 * deterministically instead of flaking (mirrors nft-bulk-actions.spec.ts's `gotoCollectiblesUnlocked`
 * / nft-trade-picker.spec.ts's `gotoTradeUnlocked`). */
async function gotoCollectiblesUnlocked(page: Page): Promise<void> {
  await page.goto(`chrome-extension://${extensionId}/app.html#wallet/collectibles`);
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

test.describe('NFT collection metadata + richer gallery (#98)', () => {
  test('the SW reaches an arbitrary off-chain metadata host (no CORS header) via a REAL fetch(), and the gallery shows the resolved name', async () => {
    await ensureUnlocked();
    const page = await context.newPage();
    await gotoCollectiblesUnlocked(page);

    // The real off-chain name resolves in the grid tile (falls back to the shortened id otherwise).
    await expect(page.getByTestId(`nft-tile-${NFT_WITH_METADATA.launcherId}`)).toContainText('Cool Cat #1');
    expect(metadataFetchCount).toBeGreaterThan(0); // proves the SW's fetch() actually reached the host

    await page.screenshot({ path: 'test-results/nft-collection-metadata-gallery.png' });
  });

  test('the collection group header shows the resolved off-chain collection name', async () => {
    await ensureUnlocked();
    const page = await context.newPage();
    await gotoCollectiblesUnlocked(page);
    await expect(page.getByTestId(`collection-header-${NFT_WITH_METADATA.collectionId}`)).toContainText('Cool Cats Club');
  });

  test('the detail view shows the resolved name, description, and attributes', async () => {
    await ensureUnlocked();
    const page = await context.newPage();
    await gotoCollectiblesUnlocked(page);
    await page.getByTestId(`nft-tile-${NFT_WITH_METADATA.launcherId}`).click();
    await expect(page.getByTestId('nft-detail')).toBeVisible();

    await expect(page.getByRole('heading', { name: 'Cool Cat #1' })).toBeVisible();
    await expect(page.getByTestId('nft-detail-description')).toHaveText('A very cool cat, e2e-98 fixture.');
    await expect(page.getByTestId('nft-detail-attributes')).toContainText('Eyes');
    await expect(page.getByTestId('nft-detail-attributes')).toContainText('Green');
    await expect(page.getByTestId('nft-collection')).toHaveText('Cool Cats Club');

    await page.screenshot({ path: 'test-results/nft-collection-metadata-detail.png' });
  });
});
