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
 * END-USER e2e for #173 (NFT detail: click the image to open an XL "view larger" lightbox) — proves,
 * against the BUILT unpacked extension in a real (headless) browser, that:
 *   - clicking the NFT detail hero image opens a labelled modal dialog showing the SAME image (the
 *     already-cached blob URL, #159) fit-to-viewport;
 *   - it closes via the close button, a backdrop click, and Escape;
 *   - an NFT with no art (the monogram fallback, #150) offers no clickable trigger and never opens an
 *     empty lightbox.
 *
 * `listNfts` is intercepted at the `chrome.runtime.sendMessage` seam (same technique as its sibling
 * `nft-image-display.spec.ts`) so the grid — and the detail view it opens into — always renders a
 * fixed, known NFT. The image itself is a real network-layer fixture (`context.route`), not mocked at
 * the message layer, so the real `<img>` load + local-cache path is exercised end-to-end.
 *
 * Run: `npm run build && npm run test:sw`.
 */

const EXT_PATH = resolve(process.cwd(), 'dist');
const GOLDEN = JSON.parse(readFileSync(resolve(process.cwd(), 'src/lib/keystore/derive.golden.json'), 'utf8')) as { mnemonic: string };

// A real (non-trivial-size) image, not a 1x1 pixel: the whole point of this spec is to visually
// confirm the lightbox scales art up to fill the viewport, which a 1x1 fixture can't demonstrate in
// a screenshot (it would render as an invisible speck). An inline SVG is the simplest way to author
// one by hand; browsers render it as a normal raster `<img>` the same as a PNG/JPEG.
const SVG_ART = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="420">
  <rect width="640" height="420" fill="#7a3dff"/>
  <rect x="40" y="40" width="560" height="340" fill="#c13de0"/>
  <circle cx="320" cy="210" r="120" fill="#fff"/>
  <text x="320" y="220" font-size="42" text-anchor="middle" fill="#7a3dff" font-family="sans-serif">e2e-173 art</text>
</svg>`;

const HTTPS_GOOD = 'https://picsum-e2e-173.example.test/good.svg';
const PASSWORD = 'e2e-173-not-a-real-secret';

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

const ART_NFT = nft({ launcherId: 'aa'.repeat(32), dataUris: [HTTPS_GOOD] });
const NO_ART_NFT = nft({ launcherId: 'bb'.repeat(32), dataUris: [] });
const MOCK_NFTS = [ART_NFT, NO_ART_NFT];

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

  await context.route(HTTPS_GOOD, (route) =>
    route.fulfill({ status: 200, contentType: 'image/svg+xml', headers: { 'Access-Control-Allow-Origin': '*' }, body: SVG_ART }),
  );

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

  // Kept open for the whole suite (closed only in afterAll) — see nft-image-display.spec.ts's identical
  // comment: closing the last extension page can race the offscreen vault's auto-lock.
  ext = await context.newPage();
  await ext.goto(`chrome-extension://${extensionId}/popup.html`);
  const imported = await swSend<{ lockState?: string }>(ext, { action: 'importWallet', mnemonic: GOLDEN.mnemonic, password: PASSWORD });
  expect(imported.lockState).toBe('unlocked');
});

async function ensureUnlocked(): Promise<void> {
  const res = await swSend<{ lockState?: string }>(ext, { action: 'unlockWallet', password: PASSWORD });
  expect(res.lockState).toBe('unlocked');
}

test.afterAll(async () => {
  await context?.close();
});

test.describe('NFT detail image lightbox (#173)', () => {
  test('desktop: clicking the hero image opens an XL lightbox with the same image; closes via the close button', async () => {
    await ensureUnlocked();
    const page = await context.newPage();
    // Reduced motion so the entrance transition can't leave the image mid-fade when the screenshot
    // below is taken (also exercises the `prefers-reduced-motion` path, which drops the animation).
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`chrome-extension://${extensionId}/app.html#wallet/collectibles`);

    await page.getByTestId(`nft-tile-${ART_NFT.launcherId}`).click();
    await expect(page.getByTestId('nft-detail')).toBeVisible();

    const trigger = page.getByTestId('nft-image-trigger');
    await expect(trigger).toBeVisible();
    const heroSrc = await trigger.getByTestId('nft-image').getAttribute('src');
    expect(heroSrc).toMatch(/^blob:/);

    await expect(page.getByTestId('nft-lightbox')).toHaveCount(0);
    await trigger.click();

    const lightbox = page.getByTestId('nft-lightbox');
    await expect(lightbox).toBeVisible();
    await expect(page.getByRole('dialog')).toBeVisible();
    const lightboxImg = page.getByTestId('nft-lightbox-image');
    await expect(lightboxImg).toHaveAttribute('src', heroSrc!); // the SAME cached src — no re-fetch
    expect(await lightboxImg.evaluate((img: HTMLImageElement) => img.naturalWidth > 0)).toBe(true);

    await page.screenshot({ path: 'test-results/nft-image-lightbox-desktop-open.png' });

    await page.getByTestId('nft-lightbox-close').click();
    await expect(lightbox).toHaveCount(0);
  });

  test('mobile-width: the lightbox also fits the phone-frame viewport; closes via a backdrop click and Escape', async () => {
    await ensureUnlocked();
    const page = await context.newPage();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 390, height: 700 });
    await page.goto(`chrome-extension://${extensionId}/popup.html#wallet/collectibles`);

    await page.getByTestId(`nft-tile-${ART_NFT.launcherId}`).click();
    await page.getByTestId('nft-image-trigger').click();
    await expect(page.getByTestId('nft-lightbox')).toBeVisible();
    await page.screenshot({ path: 'test-results/nft-image-lightbox-mobile-open.png' });

    // Click the dimmed backdrop itself (outside the image) — not the image — to close.
    await page.getByTestId('nft-lightbox').click({ position: { x: 4, y: 4 } });
    await expect(page.getByTestId('nft-lightbox')).toHaveCount(0);

    await page.getByTestId('nft-image-trigger').click();
    await expect(page.getByTestId('nft-lightbox')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('nft-lightbox')).toHaveCount(0);
  });

  test('an NFT with no art (monogram fallback, #150) offers no trigger and never opens an empty lightbox', async () => {
    await ensureUnlocked();
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/app.html#wallet/collectibles`);

    await page.getByTestId(`nft-tile-${NO_ART_NFT.launcherId}`).click();
    await expect(page.getByTestId('nft-detail')).toBeVisible();
    await expect(page.getByTestId('nft-monogram')).toBeVisible();
    await expect(page.getByTestId('nft-image-trigger')).toHaveCount(0);

    await page.getByTestId('nft-monogram').click({ force: true });
    await expect(page.getByTestId('nft-lightbox')).toHaveCount(0);
  });
});
