import { test, type Page } from '@playwright/test';

/**
 * Mobile-OS screenshot harness (#65 acceptance bar): render the real built popup.html / app.html
 * with a stubbed `chrome.*` (canned unlocked wallet + balances + node status) and capture the Home
 * launcher + each screen at phone (popup) and tablet (fullscreen app.html) widths. The dApp catalog
 * is stubbed via a route so icons render deterministically. Output → e2e/__screenshots__/.
 */

const CATALOG = {
  generatedAt: '2026-07-05T00:00:00Z',
  version: '0.5.0',
  apps: [
    { slug: 'chia-offer', name: 'Chia-Offer', icon: 'https://explore.dig.net/catalog/chia-offer/icon-512.png', link: 'https://chia-offer.on.dig.net/', category: 'tools', featured: true, accentColor: '#3aaa35' },
    { slug: 'xchtip', name: 'xchtip.app', icon: 'https://explore.dig.net/catalog/xchtip/icon-512.png', link: 'https://xchtip.app/', category: 'payments', featured: true, accentColor: '#f5b642' },
    { slug: 'hashtunes', name: 'HashTunes', icon: 'https://explore.dig.net/catalog/hashtunes/icon-512.png', link: 'https://hashtunes.on.dig.net/', category: 'tools', featured: false, accentColor: '#fb81ed' },
    { slug: 'dexie', name: 'Dexie', icon: 'https://explore.dig.net/catalog/dexie/icon-512.png', link: 'https://dexie.space/', category: 'defi', featured: false, accentColor: '#7a3dff' },
  ],
};

/** Injected before the app boots: a chrome.* stub answering the shell's reads with canned data. */
const STUB = `
(() => {
  const canned = (msg) => {
    const a = msg && msg.action;
    if (a === 'getLockState') return { lockState: 'unlocked' };
    if (a === 'getCustodyBalances') return { balances: { xch: 2510000000000, cats: {} } };
    if (a === 'getReceiveAddress') return { address: 'xch1qqqqdigmobileoshomescreendemoaddressqqqqqqqqqqqqqqqqqqqqzzzz' };
    if (a === 'listCoins') return { coins: [
      { coinId: 'a'.repeat(64), amount: '1500000000000', confirmedHeight: 5012345 },
      { coinId: 'b'.repeat(64), amount: '1000000000000', confirmedHeight: 5012300 },
      { coinId: 'c'.repeat(64), amount: '10000000000', confirmedHeight: 5011000 }
    ] };
    if (a === 'getActivity') return { events: [
      { id: 'r:1', kind: 'received', asset: 'XCH', amount: '500000000000', counterparty: null, height: 5, timestamp: 1751000000, coinId: 'ab' },
      { id: 's:2', kind: 'sent', asset: 'XCH', amount: '120000000000', counterparty: 'xch1recipient', height: 4, timestamp: 1750900000, coinId: 'cd' }
    ], cursorHeight: 5 };
    if (a === 'listNfts') return { nfts: [
      { launcherId: 'ab'.repeat(32), coinId: 'cd'.repeat(32), p2PuzzleHash: 'ef'.repeat(32), collectionId: null, editionNumber: '1', editionTotal: '1', royaltyBasisPoints: 250, royaltyPuzzleHash: '00'.repeat(32), dataUris: ['https://ipfs.example/1.png'], dataHash: null, metadataUris: [], metadataHash: null, licenseUris: [] },
    ] };
    if (a === 'listDids') return { dids: [
      { launcherId: 'aa'.repeat(32), coinId: 'bb'.repeat(32), p2PuzzleHash: 'cc'.repeat(32), recoveryListHash: null, numVerificationsRequired: '1', profileName: 'Screenshot DID' },
    ] };
    if (a === 'inspectOffer') return { offerSummary: {
      offered: [{ asset: { kind: 'xch' }, amount: '100000000000' }],
      requested: [{ asset: { kind: 'cat', assetId: 'aa'.repeat(32) }, amount: '250', toPuzzleHashHex: 'ab' }],
    } };
    if (a === 'getDigNodeStatus') return { reachable: true, base: 'https://dig.local' };
    if (a === 'getControlStatus') return { mode: 'manage', localNode: true, base: 'https://dig.local', status: null, controlMethods: [] };
    if (a === 'getConnection') return { connected: false };
    return { success: true };
  };
  const store = {};
  window.chrome = {
    runtime: {
      id: 'screenshot-harness',
      sendMessage: (msg, cb) => { const r = canned(msg); if (typeof cb === 'function') { cb(r); return; } return Promise.resolve(r); },
      getURL: (p) => p,
      onMessage: { addListener() {}, removeListener() {} },
      openOptionsPage() {},
    },
    storage: {
      local: {
        get: (keys, cb) => { const r = {}; if (typeof cb === 'function') { cb(r); return; } return Promise.resolve(r); },
        set: (o, cb) => { Object.assign(store, o); if (typeof cb === 'function') { cb(); return; } return Promise.resolve(); },
        remove: () => Promise.resolve(),
        onChanged: { addListener() {}, removeListener() {} },
      },
      session: { get: () => Promise.resolve({}), set: () => Promise.resolve() },
      onChanged: { addListener() {}, removeListener() {} },
    },
    tabs: { create() {} },
  };
})();
`;

async function open(page: Page, file: string, hash: string) {
  await page.addInitScript(STUB);
  await page.route('**/store.json', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(CATALOG) }));
  await page.goto(`/${file}#${hash}`);
  await page.waitForTimeout(700); // let queries resolve + the screen-enter transition settle
}

const PHONE = { width: 372, height: 600 };
const TABLET = { width: 1200, height: 860 };

for (const screen of ['home', 'wallet', 'apps', 'network']) {
  test(`popup ${screen}`, async ({ page }) => {
    await page.setViewportSize(PHONE);
    await open(page, 'popup.html', screen);
    await page.screenshot({ path: `e2e/__screenshots__/popup-${screen}.png` });
  });
}

for (const screen of ['home', 'wallet', 'apps', 'network']) {
  test(`fullscreen ${screen}`, async ({ page }) => {
    await page.setViewportSize(TABLET);
    await open(page, 'app.html', screen);
    await page.screenshot({ path: `e2e/__screenshots__/fullscreen-${screen}.png` });
  });
}

// Coin control (#91): the Coins panel — list of individual coins + split/combine actions.
test('popup coins (coin control)', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await open(page, 'popup.html', 'wallet');
  await page.getByTestId('action-coins').click();
  await page.getByTestId('coin-control').waitFor();
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'e2e/__screenshots__/popup-coins.png' });
});

test('fullscreen coins (coin control)', async ({ page }) => {
  await page.setViewportSize(TABLET);
  await open(page, 'app.html', 'wallet');
  await page.getByTestId('action-coins').click();
  await page.getByTestId('coin-control').waitFor();
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'e2e/__screenshots__/fullscreen-coins.png' });
});

// NFT minting (#92): advanced → fullscreen only. The fullscreen collectibles view exposes "Mint NFT";
// the popup shows a view-only "Mint in full screen" affordance (never the form).
test('fullscreen mint (NFT minting form)', async ({ page }) => {
  await page.setViewportSize(TABLET);
  await open(page, 'app.html', 'wallet/collectibles');
  await page.getByTestId('collectibles-mint').click();
  await page.getByTestId('mint-form').waitFor();
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'e2e/__screenshots__/fullscreen-mint.png' });
});

test('popup collectibles (view-only, mint moved to full screen)', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await open(page, 'popup.html', 'wallet/collectibles');
  await page.getByTestId('collectibles-mint-fullscreen').waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'e2e/__screenshots__/popup-collectibles.png' });
});

// In-window dApp app-view (§2.4a): tap a launcher icon → the dApp opens INSIDE the frame.
test('popup app-view (dApp opened in-window)', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await page.route('https://chia-offer.on.dig.net/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<body style="font-family:system-ui;margin:0;padding:28px;background:#faf9fd"><h1 style="color:#3aaa35">Chia-Offer</h1><p>Trustless Chia offers, running inside DIG.</p></body>' }),
  );
  await open(page, 'popup.html', 'home');
  await page.getByTestId('app-tile-chia-offer').click();
  await page.getByTestId('appview-frame').waitFor();
  await page.waitForTimeout(900);
  await page.screenshot({ path: 'e2e/__screenshots__/popup-appview.png' });
});

// DID management (#93): advanced → fullscreen only (§145). The fullscreen Identity view exposes
// "Create DID" + per-DID "Transfer"/"Edit profile"; the popup shows a view-only list with an "open
// full screen" affordance (never any of the forms).
test('fullscreen identity (DID list)', async ({ page }) => {
  await page.setViewportSize(TABLET);
  await open(page, 'app.html', 'wallet/did');
  await page.getByTestId('identity-panel').waitFor();
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'e2e/__screenshots__/fullscreen-identity.png' });
});

test('popup identity (view-only, create/transfer moved to full screen)', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await open(page, 'popup.html', 'wallet/did');
  await page.getByTestId('identity-create-fullscreen').waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'e2e/__screenshots__/popup-identity.png' });
});

test('fullscreen create DID form', async ({ page }) => {
  await page.setViewportSize(TABLET);
  await open(page, 'app.html', 'wallet/did');
  await page.getByTestId('identity-create').click();
  await page.getByTestId('did-create-form').waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'e2e/__screenshots__/fullscreen-did-create.png' });
});

test('fullscreen DID detail (transfer + edit profile)', async ({ page }) => {
  await page.setViewportSize(TABLET);
  await open(page, 'app.html', 'wallet/did');
  await page.getByTestId(`did-tile-${'aa'.repeat(32)}`).click();
  await page.getByTestId('did-detail').waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'e2e/__screenshots__/fullscreen-did-detail.png' });
});

test('fullscreen edit DID profile form', async ({ page }) => {
  await page.setViewportSize(TABLET);
  await open(page, 'app.html', 'wallet/did');
  await page.getByTestId(`did-tile-${'aa'.repeat(32)}`).click();
  await page.getByTestId('did-profile-open').click();
  await page.getByTestId('did-profile-form').waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'e2e/__screenshots__/fullscreen-did-profile.png' });
});

// Assign a wallet-owned DID as an NFT's owner (#93): advanced → fullscreen only (§145).
test('fullscreen NFT detail (assign DID owner)', async ({ page }) => {
  await page.setViewportSize(TABLET);
  await open(page, 'app.html', 'wallet/collectibles');
  await page.getByTestId(`nft-tile-${'ab'.repeat(32)}`).click();
  await page.getByTestId('nft-detail').waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'e2e/__screenshots__/fullscreen-nft-detail.png' });
});

test('fullscreen assign DID owner (NFT ↔ DID picker)', async ({ page }) => {
  await page.setViewportSize(TABLET);
  await open(page, 'app.html', 'wallet/collectibles');
  await page.getByTestId(`nft-tile-${'ab'.repeat(32)}`).click();
  await page.getByTestId('nft-assign-open').click();
  await page.getByTestId('nft-assign-pick').waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'e2e/__screenshots__/fullscreen-nft-assign.png' });
});

// Trade offers (#94): advanced → fullscreen only (§145). The popup shows a view-only "open full
// screen" affordance; the fullscreen Trade view exposes the make/take forms, incl. offering an
// owned NFT (give-kind picker) and taking via paste OR drag-and-drop of an offer file.
test('popup trade (view-only, make/take moved to full screen)', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await open(page, 'popup.html', 'wallet/trade');
  await page.getByTestId('trade-open-fullscreen').waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'e2e/__screenshots__/popup-trade.png' });
});

test('fullscreen trade (make form)', async ({ page }) => {
  await page.setViewportSize(TABLET);
  await open(page, 'app.html', 'wallet/trade');
  await page.getByTestId('trade-make-form').waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'e2e/__screenshots__/fullscreen-trade-make.png' });
});

test('fullscreen trade — give an NFT (offering a self-custody singleton)', async ({ page }) => {
  await page.setViewportSize(TABLET);
  await open(page, 'app.html', 'wallet/trade');
  await page.getByTestId('trade-give-kind-nft').click();
  await page.getByTestId('trade-give-nft').waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'e2e/__screenshots__/fullscreen-trade-give-nft.png' });
});

test('fullscreen trade — take (paste + drag-and-drop an offer file)', async ({ page }) => {
  await page.setViewportSize(TABLET);
  await open(page, 'app.html', 'wallet/trade');
  await page.getByTestId('trade-mode-take').click();
  await page.getByTestId('trade-take-dropzone').waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'e2e/__screenshots__/fullscreen-trade-take.png' });
});

// Two ways to bring an offer INTO the wallet to accept it (#94): paste the `offer1…` code, or
// drag-and-drop an `.offer`/text file containing it. Both feed the SAME inspect→take path.
test('accept an offer by PASTING the offer1… code', async ({ page }) => {
  await open(page, 'app.html', 'wallet/trade');
  await page.getByTestId('trade-mode-take').click();
  await page.getByTestId('trade-take-input').fill('offer1qqqexampleofferstringqqq');
  await page.getByTestId('trade-take-review-btn').click();
  await page.getByTestId('trade-take-review').waitFor();
  await page.locator('[data-testid="trade-summary-get"]:has-text("XCH")').waitFor();
});

test('accept an offer by DROPPING an .offer file onto the dropzone', async ({ page }) => {
  await open(page, 'app.html', 'wallet/trade');
  await page.getByTestId('trade-mode-take').click();
  const dropzone = page.getByTestId('trade-take-dropzone');
  await dropzone.waitFor();
  // Playwright has no native drag-drop-a-file API for a non-<input> dropzone — dispatch a real
  // DragEvent carrying a DataTransfer + File, exactly what a user's OS file drag produces.
  await dropzone.dispatchEvent('drop', {
    dataTransfer: await page.evaluateHandle(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(['offer1qqqexampleofferstringqqq'], 'my-trade.offer', { type: 'text/plain' }));
      return dt;
    }),
  });
  await page.getByTestId('trade-take-review').waitFor();
  await page.locator('[data-testid="trade-summary-get"]:has-text("XCH")').waitFor();
});

// Framing-failure fallback: an unreachable/refused embed → the blocked note (never a blank frame).
// (An X-Frame-Options refusal still fires `load` + throws on cross-origin access — indistinguishable
// from success in pure JS — so the reliable, detectable signals are a load error or no-load timeout;
// here we hang the frame request so the load-timeout fires the graceful fallback.)
test('popup app-view blocked (embed fails → open-in-tab note)', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await page.route('https://chia-offer.on.dig.net/**', async (route) => {
    await new Promise((r) => setTimeout(r, 8000)); // never loads within the app-view timeout
    await route.abort();
  });
  await open(page, 'popup.html', 'home');
  await page.getByTestId('app-tile-chia-offer').click();
  await page.getByTestId('appview-blocked').waitFor({ timeout: 9000 });
  await page.screenshot({ path: 'e2e/__screenshots__/popup-appview-blocked.png' });
});
