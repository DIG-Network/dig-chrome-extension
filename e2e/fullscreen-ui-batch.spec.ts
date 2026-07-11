import { test, expect, type Page } from '@playwright/test';

/**
 * Screenshot + spacing verification for the fullscreen-UI batch (#421 flush-top URN bar, #411
 * Advertise tab, #393 Peers tab, #394 wallet-backend selector). Serves the real built popup.html /
 * app.html over the static harness with a stubbed `chrome.*` (canned unlocked wallet + an online
 * node reporting a peer list), so the new views render at phone (popup) + tablet (fullscreen)
 * widths. Output → e2e/__screenshots__/. Not a CI gate — a visual-verification tool (§6.5).
 */

/** chrome.* stub: unlocked wallet, an online dig-node, a canned peer list, a reachable Sage source. */
const STUB = `
(() => {
  const canned = (msg) => {
    const a = msg && msg.action;
    if (a === 'getLockState') return { lockState: 'unlocked' };
    if (a === 'getCustodyBalances') return { balances: { xch: 2510000000000, cats: {} } };
    if (a === 'getReceiveAddress') return { address: 'xch1qqqqfullscreenuibatchdemoaddressqqqqqqqqqqqqqqqqqqqqqqzzzz' };
    if (a === 'getActivity') return { events: [] };
    if (a === 'listCoins') return { coins: [] };
    if (a === 'getDigNodeStatus') return { reachable: true, base: 'https://dig.local' };
    if (a === 'getControlStatus') return { mode: 'manage', localNode: true, base: 'https://dig.local', status: {}, authRequired: false, controlMethods: [] };
    // #393 — the Peers tab reads control.peerStatus (via controlAuthed). Canned running node with a
    // per-peer list + management_supported so the table + management controls render.
    if (a === 'controlAuthed' && msg.method === 'control.peerStatus') return {
      running: true,
      connected_peers: 2,
      management_supported: true,
      peers: [
        { peer_id: 'dig1qpeeralpha00000000000000000000000000000000000000', addresses: ['[2001:db8::a1]:8444'], connection_type: 'direct', direction: 'outbound', latency_ms: 38 },
        { peer_id: 'dig1qpeerbeta000000000000000000000000000000000000000', addresses: ['[2001:db8::b2]:8444'], connection_type: 'relayed', direction: 'inbound', latency_ms: 121 },
      ],
      bans: ['dig1qbannedpeer0000000000000000000000000000000000000'],
      max_connections: 64,
    };
    // #394 — the Sage backend indicator reads getChainSourceStatus; report Sage reachable.
    if (a === 'getChainSourceStatus') return { mode: 'sage', resolved: { kind: 'node', base: 'http://localhost:9257', strict: true } };
    if (a === 'getConnection') return { connected: false };
    return { success: true };
  };
  const store = { 'toolbar.enabled': true };
  window.chrome = {
    runtime: {
      id: 'fullscreen-ui-batch-harness',
      sendMessage: (msg, cb) => { const r = canned(msg); if (typeof cb === 'function') { cb(r); return; } return Promise.resolve(r); },
      getURL: (p) => p,
      onMessage: { addListener() {}, removeListener() {} },
      openOptionsPage() {},
      getManifest: () => ({ version: '1.88.0' }),
    },
    commands: { getAll: (cb) => cb([{ name: 'toggle-dig-toolbar', shortcut: 'Alt+Shift+D' }]) },
    storage: {
      local: {
        get: (keys, cb) => {
          let r = {};
          if (keys == null) r = { ...store };
          else if (typeof keys === 'string') r = { [keys]: store[keys] };
          else if (Array.isArray(keys)) { for (const k of keys) r[k] = store[k]; }
          else r = { ...store };
          if (typeof cb === 'function') { cb(r); return; } return Promise.resolve(r);
        },
        set: (o, cb) => { Object.assign(store, o); if (typeof cb === 'function') { cb(); return; } return Promise.resolve(); },
        remove: (k, cb) => { delete store[k]; if (typeof cb === 'function') { cb(); return; } return Promise.resolve(); },
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
  await page.route('**/store.json', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ apps: [] }) }));
  await page.goto(`/${file}#${hash}`);
  await page.waitForTimeout(600);
}

const PHONE = { width: 372, height: 600 };
const TABLET = { width: 1200, height: 860 };

// #421 — the built-in URN bar pins flush to the very top edge of the window (shared app-shell).
test('fullscreen flush-top built-in URN bar (#421)', async ({ page }) => {
  await page.setViewportSize(TABLET);
  await open(page, 'app.html', 'home');
  const bar = page.getByTestId('builtin-dig-toolbar');
  await bar.waitFor();
  // Flush-top: the bar's top edge is at the very top of the viewport (no chrome above it).
  const box = await bar.boundingBox();
  expect(box?.y).toBeLessThanOrEqual(1);
  await page.screenshot({ path: 'e2e/__screenshots__/fullscreen-flush-toolbar.png' });
});

test('popup flush-top built-in URN bar (#421)', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await open(page, 'popup.html', 'home');
  const bar = page.getByTestId('builtin-dig-toolbar');
  await bar.waitFor();
  const box = await bar.boundingBox();
  expect(box?.y).toBeLessThanOrEqual(1);
  await page.screenshot({ path: 'e2e/__screenshots__/popup-flush-toolbar.png' });
});

// #411 — Advertise tab: a clean centered "Coming soon" placeholder.
test('fullscreen Advertise tab (#411)', async ({ page }) => {
  await page.setViewportSize(TABLET);
  await open(page, 'app.html', 'advertise');
  await page.getByTestId('advertise-comingsoon').waitFor();
  await page.screenshot({ path: 'e2e/__screenshots__/fullscreen-advertise.png' });
});

test('popup Advertise tab (#411)', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await open(page, 'popup.html', 'advertise');
  await page.getByTestId('advertise-comingsoon').waitFor();
  await page.screenshot({ path: 'e2e/__screenshots__/popup-advertise.png' });
});

// #393 — Peers tab: live peer table + management controls (node online, management supported).
test('fullscreen Peers tab (#393)', async ({ page }) => {
  await page.setViewportSize(TABLET);
  await open(page, 'app.html', 'peers');
  await page.getByTestId('peers-table').waitFor();
  await expect(page.getByTestId('peer-row').first()).toBeVisible();
  await page.screenshot({ path: 'e2e/__screenshots__/fullscreen-peers.png' });
});

test('popup Peers tab (#393)', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await open(page, 'popup.html', 'peers');
  await page.getByTestId('peers-panel').waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'e2e/__screenshots__/popup-peers.png' });
});

// #394 — the wallet-backend selector with Sage RPC picked (fullscreen-only settings block).
test('fullscreen wallet-backend selector — Sage RPC (#394)', async ({ page }) => {
  await page.setViewportSize(TABLET);
  await open(page, 'app.html', 'wallet');
  const select = page.getByTestId('chain-source-select');
  await select.waitFor();
  await select.selectOption('sage');
  await page.getByTestId('chain-source-sage').waitFor();
  await page.getByTestId('chain-source-setting').scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'e2e/__screenshots__/fullscreen-wallet-backend-sage.png' });
});
