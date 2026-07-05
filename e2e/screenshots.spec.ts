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
    if (a === 'getActivity') return { events: [
      { id: 'r:1', kind: 'received', asset: 'XCH', amount: '500000000000', counterparty: null, height: 5, timestamp: 1751000000, coinId: 'ab' },
      { id: 's:2', kind: 'sent', asset: 'XCH', amount: '120000000000', counterparty: 'xch1recipient', height: 4, timestamp: 1750900000, coinId: 'cd' }
    ], cursorHeight: 5 };
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
