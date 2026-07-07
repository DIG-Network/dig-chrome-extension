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
 * END-USER e2e for #150 (Collectibles showed a monogram placeholder instead of real NFT art) + #159
 * (local NFT image cache) — proves, against the BUILT unpacked extension in a real (headless)
 * browser, that:
 *   - an NFT with a remote `https://` image renders its thumbnail (the `img-src 'self' data: https:`
 *     CSP, manifest.json, now allows it — it used to be CSP-blocked and fall back to the monogram),
 *     served through the local NFT image cache as a `blob:` object URL (#159) — never the raw remote
 *     URL directly, so a render never re-hits the network once cached;
 *   - an NFT with a raw `ipfs://` image is gateway-rewritten (`toGatewayUrl`, `nftDisplay.ts`) to a
 *     fetchable `https://ipfs.io/ipfs/...` URL, cached, and renders too;
 *   - an NFT whose image URL fails to load (dead host) falls back to the monogram via the cache/fetch
 *     failure path (`useCachedNftImageSrc`, `NftDetail.tsx`) — the grid never shows a broken-image icon;
 *   - a cached image is served from the LOCAL cache (no re-fetch) on a later, independent view (a
 *     fresh popup/app document — the real-world "close and reopen the popup" case).
 *
 * `listNfts` is intercepted at the `chrome.runtime.sendMessage` seam (real chain discovery needs a
 * live coinset scan of a wallet that may or may not hold any NFTs — non-deterministic in CI, the same
 * split as the #92/#94 vault e2e) so the grid renders a fixed, known set of NFTs. The actual IMAGE
 * requests are NOT mocked at the message layer — they are real `<img>`-driven fetches intercepted at
 * the network layer (`context.route`, counted per URL) so the browser's own CSP + the real Cache API
 * + `<img onerror>` behavior is exercised end-to-end, not simulated.
 *
 * NOT covered here: a CORS-restricted host (no `Access-Control-Allow-Origin`) gracefully falling back
 * to the raw, uncached URL (`nftImageCache.ts`'s `loadImageBlobViaCanvas` doc comment). Playwright's
 * `context.route().fulfill()` interception does not enforce real browser CORS checks on
 * `crossOrigin="anonymous"` image loads (verified: a route responding with NO
 * `Access-Control-Allow-Origin` header still loads successfully under this harness), so that fallback
 * path is unit-tested instead (`NftDetail.test.tsx`, "falls back to embedding the raw remote URL").
 *
 * Run: `npm run build && npm run test:sw`.
 */

const EXT_PATH = resolve(process.cwd(), 'dist');
const GOLDEN = JSON.parse(readFileSync(resolve(process.cwd(), 'src/lib/keystore/derive.golden.json'), 'utf8')) as { mnemonic: string };

// A 1x1 transparent PNG — the smallest valid image payload, used to fulfill the "good" image routes.
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

const HTTPS_GOOD = 'https://picsum-e2e-150.example.test/good.png';
const IPFS_CID_PATH = 'bafy-e2e-150/good.png';
const IPFS_GATEWAY_GOOD = `https://ipfs.io/ipfs/${IPFS_CID_PATH}`;
const HTTPS_DEAD = 'https://dead-e2e-150.example.test/broken.png';
const HTTPS_CACHE_TEST = 'https://cache-e2e-159.example.test/cached.png';
const PASSWORD = 'e2e-150-not-a-real-secret';

/** Per-URL network hit counts (populated by the `context.route` handlers in `beforeAll`) — proves
 * the local NFT image cache (#159) really does skip the network on a cache hit, not just that the
 * rendered `<img>` LOOKS right. */
const fetchCounts: Record<string, number> = {};

function nft(over: Partial<MockNft> & { launcherId: string; dataUris: string[] }): MockNft {
  return {
    coinId: 'cd'.repeat(32),
    p2PuzzleHash: 'ef'.repeat(32),
    collectionId: null,
    editionNumber: '1',
    editionTotal: '1',
    royaltyBasisPoints: 0,
    royaltyPuzzleHash: '00'.repeat(32),
    dataHash: null,
    metadataUris: [],
    metadataHash: null,
    licenseUris: [],
    ...over,
  };
}

const REMOTE_NFT = nft({ launcherId: 'aa'.repeat(32), dataUris: [HTTPS_GOOD] });
const IPFS_NFT = nft({ launcherId: 'bb'.repeat(32), dataUris: [`ipfs://${IPFS_CID_PATH}`] });
const BROKEN_NFT = nft({ launcherId: 'cc'.repeat(32), dataUris: [HTTPS_DEAD] });
const CACHE_TEST_NFT = nft({ launcherId: 'dd'.repeat(32), dataUris: [HTTPS_CACHE_TEST] });
const MOCK_NFTS = [REMOTE_NFT, IPFS_NFT, BROKEN_NFT, CACHE_TEST_NFT];

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

  // Network-layer fixtures (not message mocks): a real image response for the "good" NFT images
  // (one https-native, one only reachable AFTER the ipfs:// -> gateway rewrite, one dedicated to the
  // cache-hit test), and a real failure for the "broken" one, so <img onerror> / the cache's load
  // failure path actually fires. Each route counts its own hits so the cache-hit test can assert a
  // 2nd view makes NO additional request. `Access-Control-Allow-Origin: *` mirrors real permissive
  // gateways (ipfs.io sends this for public content), which is what lets the local NFT image cache's
  // `<img crossOrigin="anonymous">` + canvas loader (#159, `nftImageCache.ts`) read the pixels to
  // cache them — a plain `<img src>` (#150) never needed it.
  const countedFulfill = (url: string) => (route: import('@playwright/test').Route) => {
    fetchCounts[url] = (fetchCounts[url] ?? 0) + 1;
    return route.fulfill({ status: 200, contentType: 'image/png', headers: { 'Access-Control-Allow-Origin': '*' }, body: PNG_1PX });
  };
  await context.route(HTTPS_GOOD, countedFulfill(HTTPS_GOOD));
  await context.route(IPFS_GATEWAY_GOOD, countedFulfill(IPFS_GATEWAY_GOOD));
  await context.route(HTTPS_CACHE_TEST, countedFulfill(HTTPS_CACHE_TEST));
  await context.route(HTTPS_DEAD, (route) => route.fulfill({ status: 404, body: 'not found' }));

  // Intercept ONLY the `listNfts` SW action, context-wide (every page/tab opened in this context —
  // the initial import page AND each fresh popup/app page a test opens), so the grid always renders
  // a known, fixed NFT set; every other action (import/unlock, etc.) flows through to the real
  // background service worker untouched.
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

  // A setup page imports the wallet into the shared offscreen vault. This page is deliberately kept
  // OPEN for the whole suite (closed only in afterAll): auto-lock fires on an all-extension-windows-
  // closed transition (the offscreen vault tears down its key), so if this were the ONLY open
  // extension page and got closed between tests, the wallet would re-lock and every test after the
  // first would see the "Unlock your wallet" gate instead of the Collectibles grid.
  ext = await context.newPage();
  await ext.goto(`chrome-extension://${extensionId}/popup.html`);
  const imported = await swSend<{ lockState?: string }>(ext, { action: 'importWallet', mnemonic: GOLDEN.mnemonic, password: PASSWORD });
  expect(imported.lockState).toBe('unlocked');
});

/**
 * Re-unlock right before rendering the UI (via the still-open `ext` page): Chrome's real `chrome.idle`
 * detection reports `idle` after ~60s of genuinely zero OS-level input — inherent to headless
 * automation with no real user activity — and the SW auto-locks the vault on that transition
 * (`chrome.idle.onStateChanged`, `background/index.ts`). Re-unlocking makes each UI check
 * independent of how much wall-clock time earlier tests/specs in this worker consumed.
 */
async function ensureUnlocked(): Promise<void> {
  const res = await swSend<{ lockState?: string }>(ext, { action: 'unlockWallet', password: PASSWORD });
  expect(res.lockState).toBe('unlocked');
}

test.afterAll(async () => {
  await context?.close();
});

test.describe('Collectibles renders remote NFT art (#150)', () => {
  test('popup surface (mobile-width): remote https + gateway-rewritten ipfs images render; the broken one falls back to the monogram', async () => {
    // A FRESH page (not a same-document hash change on an already-mounted app) so the React shell
    // mounts cold and reads the just-imported wallet's authoritative (storage-derived) lock state.
    await ensureUnlocked();
    const page = await context.newPage();
    await page.setViewportSize({ width: 390, height: 700 });
    await page.goto(`chrome-extension://${extensionId}/popup.html#wallet/collectibles`);

    const remoteTile = page.getByTestId(`nft-tile-${REMOTE_NFT.launcherId}`);
    const ipfsTile = page.getByTestId(`nft-tile-${IPFS_NFT.launcherId}`);
    const brokenTile = page.getByTestId(`nft-tile-${BROKEN_NFT.launcherId}`);
    await expect(remoteTile).toBeVisible();
    await expect(ipfsTile).toBeVisible();
    await expect(brokenTile).toBeVisible();

    // The remote https:// image is fetched, cached locally, and embedded as a `blob:` object URL
    // (#159) — never the raw remote URL directly.
    const remoteImg = remoteTile.getByTestId('nft-image');
    await expect(remoteImg).toBeVisible();
    await expect(remoteImg).toHaveAttribute('src', /^blob:/);
    expect(await remoteImg.evaluate((img: HTMLImageElement) => img.naturalWidth > 0)).toBe(true);

    // The ipfs:// image is gateway-rewritten, fetched via the public https gateway, and served the
    // same cached way.
    const ipfsImg = ipfsTile.getByTestId('nft-image');
    await expect(ipfsImg).toBeVisible();
    await expect(ipfsImg).toHaveAttribute('src', /^blob:/);
    expect(await ipfsImg.evaluate((img: HTMLImageElement) => img.naturalWidth > 0)).toBe(true);

    // The dead-host image fails to load and falls back to the monogram (never a broken-image icon).
    await expect(brokenTile.getByTestId('nft-monogram')).toBeVisible();
    await expect(brokenTile.getByTestId('nft-image')).toHaveCount(0);

    // Element-scoped (not page-level) screenshot: the phone-frame content area scrolls
    // independently of the outer viewport (the mobile-OS sticky bottom nav, §2.1), so a plain
    // full-page capture crops the grid. Scoping to the panel itself gets the real rendered tiles
    // regardless of scroll position.
    await page.getByTestId('collectibles-panel').screenshot({ path: 'test-results/nft-image-display-popup.png' });
    // Pages are intentionally left open (closed only by afterAll's context.close()): closing the
    // last non-setup page can race the vault's window-count-driven auto-lock and re-lock the
    // wallet before the next test's fresh page reads lock state.
  });

  test('fullpage surface (desktop-width): the same three NFTs render identically', async () => {
    await ensureUnlocked();
    const page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`chrome-extension://${extensionId}/app.html#wallet/collectibles`);

    const remoteTile = page.getByTestId(`nft-tile-${REMOTE_NFT.launcherId}`);
    const ipfsTile = page.getByTestId(`nft-tile-${IPFS_NFT.launcherId}`);
    const brokenTile = page.getByTestId(`nft-tile-${BROKEN_NFT.launcherId}`);
    await expect(remoteTile).toBeVisible();
    await expect(ipfsTile).toBeVisible();
    await expect(brokenTile).toBeVisible();

    await expect(remoteTile.getByTestId('nft-image')).toHaveAttribute('src', /^blob:/);
    await expect(ipfsTile.getByTestId('nft-image')).toHaveAttribute('src', /^blob:/);
    await expect(brokenTile.getByTestId('nft-monogram')).toBeVisible();

    await page.screenshot({ path: 'test-results/nft-image-display-fullpage.png' });
  });

  test('a cached NFT image is served from the local cache on a later view — no re-fetch (#159)', async () => {
    await ensureUnlocked();
    const page1 = await context.newPage();
    await page1.goto(`chrome-extension://${extensionId}/popup.html#wallet/collectibles`);
    const img1 = page1.getByTestId(`nft-tile-${CACHE_TEST_NFT.launcherId}`).getByTestId('nft-image');
    await expect(img1).toBeVisible();
    await expect(img1).toHaveAttribute('src', /^blob:/);
    await page1.close();

    const countAfterFirstView = fetchCounts[HTTPS_CACHE_TEST] ?? 0;
    expect(countAfterFirstView).toBeGreaterThan(0); // it really did hit the network at least once

    // A brand-new page/document — the real-world "close and reopen the popup" case. The local NFT
    // image cache (Cache API, keyed by the resolved URL) must serve the same bytes with NO
    // additional network request.
    const page2 = await context.newPage();
    await page2.goto(`chrome-extension://${extensionId}/app.html#wallet/collectibles`);
    const img2 = page2.getByTestId(`nft-tile-${CACHE_TEST_NFT.launcherId}`).getByTestId('nft-image');
    await expect(img2).toBeVisible();
    await expect(img2).toHaveAttribute('src', /^blob:/);

    expect(fetchCounts[HTTPS_CACHE_TEST]).toBe(countAfterFirstView); // no new fetch on the 2nd view
  });
});
