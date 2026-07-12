import { test, expect, type Page } from '@playwright/test';

/**
 * End-user e2e + screenshots for the fullscreen Tip tab (#380, child of #377). Serves the real built
 * app.html over the static harness with a stubbed `chrome.*` that answers the node tipping WS surface
 * (SPEC §18.23) at the `chrome.runtime.sendMessage` seam: `getControlStatus` (node online), the
 * `tipRpc` methods (tip.get_config / tip.get_ledger / tip.set_config / tip.manual), `pairingState`
 * (paired, so the manage form shows), and `getReceiveAddress` (for the xchtip generator). Proves the
 * tab renders, history timeframe switching, the auto-tip config read+write over the (mocked) WS, the
 * informative empty-ledger state, and xchtip button generation. Output → e2e/__screenshots__/.
 */

const ADDR = 'xch1qqqqtippingtabdemoaddressqqqqqqqqqqqqqqqqqqqqqqqqqqqqzzzz';

const CONFIG = {
  creator: { enabled: true, dig_amount: 1000, mode: 'per-site-per-day', per_site_cap: 5000, per_site_overrides: { ['a'.repeat(64)]: 2000 } },
  dev: { enabled: true, dig_amount: 250, mode: 'per-site-per-day', per_site_cap: 0, per_site_overrides: {} },
  daily_total_cap: 10000,
  fee: 0,
};

/** Build the chrome.* stub JS. `withLedger` toggles a populated ledger vs the empty (#428) state. */
function stub(withLedger: boolean): string {
  const nowSecs = Math.floor(Date.now() / 1000);
  const ledger = withLedger
    ? [
        { id: 't1', recipient_ph: 'ec7c304708c7d59c', store_id: 'a'.repeat(64), dig_amount: 1500, ts: nowSecs - 3600, txid: 'b'.repeat(64), trigger: 'auto', kind: 'creator', status: 'confirmed' },
        { id: 't2', recipient_ph: 'ec7c304708c7d59c', dig_amount: 250, ts: nowSecs - 10 * 86400, trigger: 'auto', kind: 'dev', status: 'pending' },
      ]
    : [];
  return `
(() => {
  const CONFIG = ${JSON.stringify(CONFIG)};
  const LEDGER = ${JSON.stringify(ledger)};
  const canned = (msg) => {
    const a = msg && msg.action;
    if (a === 'getLockState') return { lockState: 'unlocked' };
    if (a === 'getReceiveAddress') return { address: '${ADDR}' };
    if (a === 'getControlStatus') return { mode: 'manage', localNode: true, base: 'https://dig.local', controlEndpoint: 'https://dig.local/', readFallback: 'https://rpc.dig.net', status: {}, authRequired: false, controlMethods: [] };
    if (a === 'pairingState') return { phase: 'paired' };
    if (a === 'tipRpc') {
      if (msg.method === 'tip.get_config') return CONFIG;
      if (msg.method === 'tip.get_ledger') return LEDGER;
      if (msg.method === 'tip.set_config') return msg.params;
      if (msg.method === 'tip.manual') return { result: 'skipped', reason: 'wallet-unavailable: not synced' };
    }
    return { success: true };
  };
  const store = {};
  window.chrome = {
    runtime: {
      id: 'tipping-tab-harness',
      sendMessage: (msg, cb) => { const r = canned(msg); if (typeof cb === 'function') { cb(r); return; } return Promise.resolve(r); },
      getURL: (p) => p,
      onMessage: { addListener() {}, removeListener() {} },
      openOptionsPage() {},
      getManifest: () => ({ version: '1.94.0' }),
    },
    commands: { getAll: (cb) => cb([]) },
    storage: {
      local: {
        get: (keys, cb) => { let r = {}; if (keys == null) r = { ...store }; else if (typeof keys === 'string') r = { [keys]: store[keys] }; else if (Array.isArray(keys)) { for (const k of keys) r[k] = store[k]; } else r = { ...store }; if (typeof cb === 'function') { cb(r); return; } return Promise.resolve(r); },
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
}

async function open(page: Page, withLedger: boolean) {
  await page.addInitScript(stub(withLedger));
  await page.route('**/store.json', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ apps: [] }) }));
  await page.goto('/app.html#tipping');
  await page.getByTestId('tipping-panel').waitFor();
  await page.waitForTimeout(500);
}

const PHONE = { width: 372, height: 720 };
const TABLET = { width: 1200, height: 900 };

test('fullscreen Tip tab — history + manage + xchtip (desktop)', async ({ page }) => {
  await page.setViewportSize(TABLET);
  await open(page, true);

  // 1. History: rows render with a summary.
  await page.getByTestId('tip-history-table').waitFor();
  await expect(page.getByTestId('tip-row').first()).toBeVisible();
  await expect(page.getByTestId('tip-history-summary')).toBeVisible();

  // 2. Manage: the editable form (both policies) renders behind the pairing gate (paired here).
  await expect(page.getByTestId('tip-manage-form')).toBeVisible();
  await expect(page.getByTestId('tip-policy-creator')).toBeVisible();
  await expect(page.getByTestId('tip-policy-dev')).toBeVisible();

  // 3. xchtip: the tip page link is generated for the wallet's XCH address.
  await expect(page.getByTestId('tip-xchtip-link')).toHaveValue(`https://xchtip.app/jar/${ADDR}`);

  await page.screenshot({ path: 'e2e/__screenshots__/fullscreen-tipping.png', fullPage: true });
});

test('Tip tab — history timeframe switching', async ({ page }) => {
  await page.setViewportSize(TABLET);
  await open(page, true);
  await page.getByTestId('tip-history-table').waitFor();
  // "all" default shows both tips; "today" drops the 10-day-old dev tip.
  await expect(page.getByTestId('tip-row')).toHaveCount(2);
  await page.getByTestId('tip-timeframe-today').click();
  await expect(page.getByTestId('tip-row')).toHaveCount(1);
});

test('Tip tab — save auto-tip config over the (mocked) WS', async ({ page }) => {
  await page.setViewportSize(TABLET);
  await open(page, true);
  const amount = page.getByTestId('tip-creator-amount');
  await amount.waitFor();
  await amount.fill('2.5');
  await page.getByTestId('tip-manage-save').click();
  await expect(page.getByTestId('tip-manage-saved')).toBeVisible();
});

test('fullscreen Tip tab — informative empty-ledger state (#428) (desktop)', async ({ page }) => {
  await page.setViewportSize(TABLET);
  await open(page, false);
  await expect(page.getByTestId('tip-history-empty')).toBeVisible();
  await expect(page.getByTestId('tipping-activation-note')).toBeVisible();
  await page.screenshot({ path: 'e2e/__screenshots__/fullscreen-tipping-empty.png', fullPage: true });
});

test('Tip tab — mobile width layout', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await open(page, true);
  await page.getByTestId('tip-history-table').waitFor();
  await expect(page.getByTestId('tip-xchtip-link')).toBeVisible();
  await page.screenshot({ path: 'e2e/__screenshots__/mobile-tipping.png', fullPage: true });
});
