import { test, expect, type Page } from '@playwright/test';

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
    // #154 — the LOCAL activity log: pending/confirmed status, no block height. A pending 'sent' row
    // demonstrates the still-in-flight state (no SpaceScan link yet); 'mint'/'did' show the new kinds.
    if (a === 'getActivity') return { events: [
      { id: 'p:pending', kind: 'sent', asset: 'XCH', amount: '75000000000', counterparty: 'xch1qqqqpendingscreenshotaddressqqqqqqqqqqqqqqqqqqqqqqqqzzzz', timestamp: 1751100000, coinId: 'ef'.repeat(32), status: 'pending' },
      { id: 'r:1', kind: 'received', asset: 'XCH', amount: '500000000000', counterparty: null, timestamp: 1751000000, coinId: 'ab'.repeat(32), status: 'confirmed' },
      { id: 's:2', kind: 'sent', asset: 'XCH', amount: '120000000000', counterparty: 'xch1recipient', timestamp: 1750900000, coinId: 'cd'.repeat(32), status: 'confirmed' },
      { id: 'mint:1', kind: 'mint', asset: 'NFT', amount: '1', counterparty: null, timestamp: 1750800000, coinId: 'aa'.repeat(32), status: 'confirmed' },
      { id: 'did:1', kind: 'did', asset: 'DID', amount: '1', counterparty: null, timestamp: 1750700000, coinId: 'bb'.repeat(32), status: 'confirmed' },
    ] };
    if (a === 'listNfts') return { nfts: [
      { launcherId: 'ab'.repeat(32), coinId: 'cd'.repeat(32), p2PuzzleHash: 'ef'.repeat(32), collectionId: null, editionNumber: '1', editionTotal: '1', royaltyBasisPoints: 250, royaltyPuzzleHash: '00'.repeat(32), dataUris: ['https://ipfs.example/1.png'], dataHash: null, metadataUris: [], metadataHash: null, licenseUris: [] },
    ] };
    if (a === 'listDids') return { dids: [
      { launcherId: 'aa'.repeat(32), coinId: 'bb'.repeat(32), p2PuzzleHash: 'cc'.repeat(32), recoveryListHash: null, numVerificationsRequired: '1', profileName: 'Screenshot DID' },
    ] };
    // #152 — one incoming (claimable now) + one outgoing (still reclaimable) pending clawback.
    if (a === 'listClawbacks') return { clawbacks: [
      { direction: 'incoming', info: { senderPuzzleHashHex: 'aa'.repeat(32), receiverPuzzleHashHex: 'bb'.repeat(32), seconds: '1700000000', amount: '250000000000' }, coinIdHex: 'c1'.repeat(32) },
      { direction: 'outgoing', info: { senderPuzzleHashHex: 'cc'.repeat(32), receiverPuzzleHashHex: 'dd'.repeat(32), seconds: '9999999999', amount: '500000000000' }, coinIdHex: 'c2'.repeat(32) },
    ] };
    if (a === 'prepareClawbackAction') return { pendingId: 'clawback-pending-1', clawbackAmountOut: '249999000000' };
    if (a === 'inspectOffer') return { offerSummary: {
      offered: [{ asset: { kind: 'xch' }, amount: '100000000000' }],
      requested: [{ asset: { kind: 'cat', assetId: 'aa'.repeat(32) }, amount: '250', toPuzzleHashHex: 'ab' }],
    } };
    // CAT issuance (#97): a brand-new token's decoded (tamper-resistant) pre-sign summary + its
    // freshly-minted asset id, echoing the mode/amount/fee the form actually submitted.
    if (a === 'prepareCatIssuance') return { pendingId: 'issue-pending-1', assetId: 'ab'.repeat(32), catIssuanceSummary: {
      assetId: 'ab'.repeat(32),
      mode: (msg.catIssuance && msg.catIssuance.mode) || 'single',
      amount: (msg.catIssuance && msg.catIssuance.amount) || '1000000000',
      fee: (msg.catIssuance && msg.catIssuance.fee) || '0',
      coinCount: 1,
    } };
    if (a === 'confirmCatIssuance') return { spentCoinId: 'issue-coin-1' };
    if (a === 'sendStatus') return { confirmed: true };
    // Token swap (#103): a matching dexie offer for the wallet's DEFAULT pick ("pay XCH -> receive
    // $DIG" - the built-in $DIG row is always the second asset, #204) plus the REAL decoded offer
    // summary prepareTrade returns for the review step (the dexie numbers are display-only).
    const DIG_ASSET_ID = 'a406d3a9de984d03c9591c10d917593b434d5263cabe2b42f6b367df16832f81';
    if (a === 'dexieBrowse') return { offers: [{
      id: 'swap-offer-1',
      offer: 'offer1qqqswapscreenshotexampleqqq',
      status: 0,
      date_found: '2026-01-01T00:00:00Z',
      offered: [{ id: DIG_ASSET_ID, code: '$DIG', amount: 1000 }],
      requested: [{ id: 'xch', code: 'XCH', amount: 10 }],
    }] };
    if (a === 'prepareTrade') return { pendingId: 'swap-pending-1', offerSummary: {
      offered: [{ asset: { kind: 'cat', assetId: DIG_ASSET_ID }, amount: '1000000' }],
      requested: [{ asset: { kind: 'xch' }, amount: '10000000000000', toPuzzleHashHex: 'ab' }],
    } };
    if (a === 'confirmTrade') return { spentCoinId: 'swap-coin-1' };
    // Option contracts (#104): a decoded (tamper-resistant) mint summary + record, an empty local
    // registry (getOptions), and canned confirm/poll responses for the mint round trip.
    if (a === 'prepareOptionMint') {
      const om = msg.optionMint || {};
      const optRecord = {
        launcherId: 'ac'.repeat(32),
        creatorPuzzleHashHex: 'ad'.repeat(32),
        holderPuzzleHashHex: 'ad'.repeat(32),
        expirationSeconds: om.expirationSeconds || '9999999999',
        underlyingAmount: om.underlyingAmount || '1000000000000',
        strikeAmount: om.strikeAmount || '500000000000',
        underlyingLockParentCoinId: 'ae'.repeat(32),
        coinIdHex: 'af'.repeat(32),
      };
      return { pendingId: 'option-mint-pending-1', optionMintSummary: Object.assign({}, optRecord, { fee: om.fee || '0', coinCount: 3 }), optionRecord: optRecord };
    }
    if (a === 'confirmOptionMint') return { spentCoinId: 'option-mint-coin-1' };
    if (a === 'getOptions') return { options: [] };
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

// #163 — the popup body (`[data-testid="popup-root"]`, `.dig-main`) must NEVER scroll
// horizontally (§6.6): every popup screen's content fits the fixed 372px shell. A wide inner
// control (the wallet segmented control) may scroll WITHIN itself, but must never push the popup
// root wider than its own box.
for (const screen of ['home', 'wallet', 'apps', 'network']) {
  test(`popup ${screen} has no horizontal overflow`, async ({ page }) => {
    await page.setViewportSize(PHONE);
    await open(page, 'popup.html', screen);
    const overflow = await page.getByTestId('popup-root').evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
}

// #163 — Identity (DID management) is ADVANCED functionality (§145): the compact popup's wallet
// segmented control hides the "Identity" tab entry entirely; the fullscreen (ExpandedLayout)
// segmented control shows every wallet view, Identity included. (The DID list stays reachable
// view-only on the popup via a direct deep link — see "popup identity" below — this only governs
// which segments render as top-level TABS.)
test('popup wallet tab set hides Identity (advanced → fullscreen-only)', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await open(page, 'popup.html', 'wallet');
  await expect(page.getByTestId('seg-home')).toBeVisible();
  await expect(page.getByTestId('seg-collectibles')).toBeVisible();
  await expect(page.getByTestId('seg-did')).toHaveCount(0);
  await page.screenshot({ path: 'e2e/__screenshots__/popup-wallet-tabset.png' });
});

test('fullscreen wallet nav includes Identity (the desktop sidebar is the wallet-view nav, #85)', async ({ page }) => {
  await page.setViewportSize(TABLET);
  await open(page, 'app.html', 'wallet');
  // On the desktop workspace the in-content segmented control is hidden and the persistent sidebar
  // carries every wallet section, Identity included (it stays advanced/fullscreen-only — the popup
  // has no sidebar). The old in-content `seg-did` is intentionally hidden here.
  await expect(page.getByTestId('nav-did')).toBeVisible();
  await expect(page.getByTestId('seg-did')).toBeHidden();
});

// #154 — the local activity log ledger: pending (no SpaceScan link yet) + confirmed rows, the new
// mint/did kinds, each expandable to a receipt showing the Pending/Confirmed status.
test('popup activity (local log — pending + confirmed rows)', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await open(page, 'popup.html', 'wallet/activity');
  await page.getByTestId('custody-activity').waitFor();
  await page.getByTestId('activity-line-p:pending').click(); // expand the pending row's receipt
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'e2e/__screenshots__/popup-activity.png' });
});

test('fullscreen activity (local log — pending + confirmed rows)', async ({ page }) => {
  await page.setViewportSize(TABLET);
  await open(page, 'app.html', 'wallet/activity');
  await page.getByTestId('custody-activity').waitFor();
  await page.getByTestId('activity-line-p:pending').click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'e2e/__screenshots__/fullscreen-activity.png' });
});

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

// Clawback (#152): advanced → fullscreen only (§145). The popup shows a lighter "open full screen"
// hint when something is pending; the fullscreen Assets view links straight to the management panel.
test('popup clawback hint (view-only, management moved to full screen)', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await open(page, 'popup.html', 'wallet');
  const hint = page.getByTestId('clawback-popup-hint');
  await hint.waitFor();
  await hint.scrollIntoViewIfNeeded(); // below the fold behind the one-time privacy note (§6.5)
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'e2e/__screenshots__/popup-clawback-hint.png' });
});

test('fullscreen clawback (pending incoming + outgoing list)', async ({ page }) => {
  await page.setViewportSize(TABLET);
  await open(page, 'app.html', 'wallet');
  await page.getByTestId('action-clawback').click();
  await page.getByTestId('clawback-panel').waitFor();
  await page.getByTestId('clawback-items').waitFor();
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'e2e/__screenshots__/fullscreen-clawback.png' });
});

// Clawback is an ADVANCED send option, fullscreen-only (#152, §145): the popup's basic Send never
// shows it; the fullscreen Send form reveals the toggle + window picker.
test('fullscreen send with clawback enabled', async ({ page }) => {
  await page.setViewportSize(TABLET);
  await open(page, 'app.html', 'wallet');
  await page.getByTestId('action-send').click();
  await page.getByTestId('custody-send').waitFor();
  await page.getByTestId('send-clawback-toggle').click();
  await page.getByTestId('send-clawback-options').waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'e2e/__screenshots__/fullscreen-send-clawback.png' });
});

test('popup send never shows the clawback option', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await open(page, 'popup.html', 'wallet');
  await page.getByTestId('action-send').click();
  await page.getByTestId('custody-send').waitFor();
  await expect(page.getByTestId('send-clawback-toggle')).toHaveCount(0);
  await page.screenshot({ path: 'e2e/__screenshots__/popup-send.png' });
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

// #157 — the branded on.dig.net-matching DIG loader shows while the dApp is loading (before the
// embed resolves). The route is held open past first paint but well inside the app-view's 6s
// load-timeout, so the phase stays 'loading' long enough to capture it, at both widths.
test('popup app-view loading (branded DIG loader, #157)', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await page.route('https://chia-offer.on.dig.net/**', async (route) => {
    await new Promise((r) => setTimeout(r, 4000));
    await route.fulfill({ contentType: 'text/html', body: '<body>Chia-Offer</body>' });
  });
  await open(page, 'popup.html', 'home');
  await page.getByTestId('app-tile-chia-offer').click();
  const loading = page.getByTestId('appview-loading');
  await loading.waitFor();
  await expect(loading.getByRole('img', { name: 'DIG Network' })).toBeVisible();
  await page.waitForTimeout(400); // let the app-view's 0.24s open transition settle before capturing
  await page.screenshot({ path: 'e2e/__screenshots__/popup-appview-loading.png' });
});

test('fullscreen app-view loading (branded DIG loader, #157)', async ({ page }) => {
  await page.setViewportSize(TABLET);
  await page.route('https://chia-offer.on.dig.net/**', async (route) => {
    await new Promise((r) => setTimeout(r, 4000));
    await route.fulfill({ contentType: 'text/html', body: '<body>Chia-Offer</body>' });
  });
  await open(page, 'app.html', 'home');
  await page.getByTestId('app-tile-chia-offer').click();
  const loading = page.getByTestId('appview-loading');
  await loading.waitFor();
  await expect(loading.getByRole('img', { name: 'DIG Network' })).toBeVisible();
  await page.waitForTimeout(400); // let the app-view's 0.24s open transition settle before capturing
  await page.screenshot({ path: 'e2e/__screenshots__/fullscreen-appview-loading.png' });
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

// Trade offers (#94, redesigned for clarity + basic maker/taker by #169): a BASIC currency-for-
// currency maker/taker now renders on the popup (mode tabs + the make/take forms); only the
// ADVANCED NFT give-kind toggle stays fullscreen-only (#94/#145), reached via the persistent "open
// full screen" link.
test('popup trade (basic maker/taker — mode tabs + make form, "open full screen" for advanced)', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await open(page, 'popup.html', 'wallet/trade');
  await page.getByTestId('trade-make-form').waitFor();
  await page.getByTestId('trade-open-fullscreen').waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'e2e/__screenshots__/popup-trade.png' });
});

test('popup trade — basic Make reaches the "You give / You get" review (#169 guided steps)', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await open(page, 'popup.html', 'wallet/trade');
  await page.getByTestId('trade-give-amount').fill('0.1');
  await page.getByTestId('trade-get-amount').fill('250');
  await page.getByTestId('trade-make-continue').click();
  await page.getByTestId('trade-make-review').waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'e2e/__screenshots__/popup-trade-make-review.png' });
});

test('popup trade — basic Take reaches the two-sided review from a pasted offer (#169)', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await open(page, 'popup.html', 'wallet/trade');
  await page.getByTestId('trade-mode-take').click();
  await page.getByTestId('trade-take-input').fill('offer1qqqexampleofferstringqqq');
  await page.getByTestId('trade-take-review-btn').click();
  await page.getByTestId('trade-take-review').waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'e2e/__screenshots__/popup-trade-take-review.png' });
});

test('fullscreen trade (make form)', async ({ page }) => {
  await page.setViewportSize(TABLET);
  await open(page, 'app.html', 'wallet/trade');
  await page.getByTestId('trade-make-form').waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'e2e/__screenshots__/fullscreen-trade-make.png' });
});

test('fullscreen trade — Make reaches the "You give / You get" review (#169 guided steps)', async ({ page }) => {
  await page.setViewportSize(TABLET);
  await open(page, 'app.html', 'wallet/trade');
  await page.getByTestId('trade-give-amount').fill('0.1');
  await page.getByTestId('trade-get-amount').fill('250');
  await page.getByTestId('trade-make-continue').click();
  await page.getByTestId('trade-make-review').waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'e2e/__screenshots__/fullscreen-trade-make-review.png' });
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

// CAT issuance (#97): a destructive/advanced spend-construction op — fullscreen-ONLY (§6.4), the
// popup never offers the "Issue" tab at all (no view-only stub — nothing pending to view before a
// mint is built).
test('popup trade never shows the Issue tab (advanced → fullscreen-only)', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await open(page, 'popup.html', 'wallet/trade');
  await page.getByTestId('trade-make-form').waitFor();
  await expect(page.getByTestId('trade-mode-issue')).toHaveCount(0);
});

test('fullscreen trade — Issue tab (CAT issuance form)', async ({ page }) => {
  await page.setViewportSize(TABLET);
  await open(page, 'app.html', 'wallet/trade');
  await page.getByTestId('trade-mode-issue').click();
  await page.getByTestId('issue-form').waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'e2e/__screenshots__/fullscreen-issue-form.png' });
});

test('fullscreen trade — Issue review shows the decoded summary (supply + asset id + fee)', async ({ page }) => {
  await page.setViewportSize(TABLET);
  await open(page, 'app.html', 'wallet/trade');
  await page.getByTestId('trade-mode-issue').click();
  await page.getByTestId('issue-supply').fill('1000000');
  await page.getByTestId('issue-mode-multi').click();
  await page.getByTestId('issue-review').click();
  await page.getByTestId('issue-review-panel').waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'e2e/__screenshots__/fullscreen-issue-review.png' });
});

test('fullscreen trade — Issue confirm → confirmed (the new asset id is shown + copyable)', async ({ page }) => {
  await page.setViewportSize(TABLET);
  await open(page, 'app.html', 'wallet/trade');
  await page.getByTestId('trade-mode-issue').click();
  await page.getByTestId('issue-supply').fill('1000000');
  await page.getByTestId('issue-review').click();
  await page.getByTestId('issue-confirm').waitFor();
  await page.getByTestId('issue-confirm').click();
  await page.getByTestId('issue-confirmed').waitFor();
  await page.getByTestId('issue-confirmed-asset-id').waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'e2e/__screenshots__/fullscreen-issue-confirmed.png' });
});

// Token swap (#103): a destructive/advanced spend-construction op — fullscreen-ONLY (§6.4), the
// popup never offers the "Swap" tab at all. The default pick is "pay XCH → receive $DIG" (the
// built-in $DIG row is always the wallet's second asset, #204) — a quote appears automatically from
// the public offer book (#102), then Review decodes the REAL offer bytes exactly like the Take tab.
test('fullscreen trade — Swap tab (a quote appears for the default XCH → $DIG pick)', async ({ page }) => {
  await page.setViewportSize(TABLET);
  await open(page, 'app.html', 'wallet/trade');
  await page.getByTestId('trade-mode-swap').click();
  await page.getByTestId('swap-quote-result').waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'e2e/__screenshots__/fullscreen-swap-quote.png' });
});

test('fullscreen trade — Swap review shows the decoded (re-derived) offer summary', async ({ page }) => {
  await page.setViewportSize(TABLET);
  await open(page, 'app.html', 'wallet/trade');
  await page.getByTestId('trade-mode-swap').click();
  await page.getByTestId('swap-review').waitFor();
  await page.getByTestId('swap-review').click();
  await page.getByTestId('swap-review-panel').waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'e2e/__screenshots__/fullscreen-swap-review.png' });
});

test('fullscreen trade — Swap confirm → confirmed', async ({ page }) => {
  await page.setViewportSize(TABLET);
  await open(page, 'app.html', 'wallet/trade');
  await page.getByTestId('trade-mode-swap').click();
  await page.getByTestId('swap-review').waitFor();
  await page.getByTestId('swap-review').click();
  await page.getByTestId('swap-confirm').waitFor();
  await page.getByTestId('swap-confirm').click();
  await page.getByTestId('swap-confirmed').waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'e2e/__screenshots__/fullscreen-swap-confirmed.png' });
});

// Option contracts (#104): a destructive/advanced spend-construction op — fullscreen-ONLY (§6.4),
// the popup never offers the "Options" tab at all.
test('fullscreen trade — Options tab (mint form)', async ({ page }) => {
  await page.setViewportSize(TABLET);
  await open(page, 'app.html', 'wallet/trade');
  await page.getByTestId('trade-mode-options').click();
  await page.getByTestId('options-mint-form').waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'e2e/__screenshots__/fullscreen-options-mint-form.png' });
});

test('fullscreen trade — Options mint review shows the decoded summary (underlying + strike)', async ({ page }) => {
  await page.setViewportSize(TABLET);
  await open(page, 'app.html', 'wallet/trade');
  await page.getByTestId('trade-mode-options').click();
  await page.getByTestId('options-mint-underlying').fill('1');
  await page.getByTestId('options-mint-strike').fill('0.5');
  await page.getByTestId('options-mint-expires').fill('30');
  await page.getByTestId('options-mint-review').click();
  await page.getByTestId('options-mint-review-panel').waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'e2e/__screenshots__/fullscreen-options-mint-review.png' });
});

test('fullscreen trade — Options mint confirm → confirmed', async ({ page }) => {
  await page.setViewportSize(TABLET);
  await open(page, 'app.html', 'wallet/trade');
  await page.getByTestId('trade-mode-options').click();
  await page.getByTestId('options-mint-underlying').fill('1');
  await page.getByTestId('options-mint-strike').fill('0.5');
  await page.getByTestId('options-mint-expires').fill('30');
  await page.getByTestId('options-mint-review').click();
  await page.getByTestId('options-mint-confirm').waitFor();
  await page.getByTestId('options-mint-confirm').click();
  await page.getByTestId('options-mint-confirmed').waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'e2e/__screenshots__/fullscreen-options-mint-confirmed.png' });
});

test('fullscreen trade — Options "Your options" tab shows the empty state', async ({ page }) => {
  await page.setViewportSize(TABLET);
  await open(page, 'app.html', 'wallet/trade');
  await page.getByTestId('trade-mode-options').click();
  await page.getByTestId('options-mode-list').click();
  await page.getByTestId('options-list-empty').waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'e2e/__screenshots__/fullscreen-options-list-empty.png' });
});
