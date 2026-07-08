import { test, expect, type Page } from '@playwright/test';

/**
 * END-USER e2e for #105/#106/#107 (the send/receive trio), driven against the REAL built popup +
 * fullscreen bundles (dist-web). Same pattern as e2e/contacts.spec.ts: a canned
 * `chrome.runtime.sendMessage` stub for the SW/vault (memo/derived-address reads never touch a real
 * chain), plus a functional `chrome.storage.local` so `advanced` mode hydrates for real via the
 * shipped `storageSync` seam. Never broadcasts — `confirmSend` is stubbed and never invoked by these
 * flows (they stop at Review or a settings view).
 *
 * Run: `npm run build:web && npx playwright test e2e/send-receive-trio.spec.ts`.
 */

const RECIPIENT_ADDR = 'xch1qgp8xdq8lrsrljezregl9xk8ymw4x0h2z9m0j8zq0k7q9m8x0hqsm3g4tl';

/** chrome.* stub: an unlocked wallet, prepareSend echoes back the memo, listDerivedAddresses
 * returns a small deterministic page, and storage.local is FUNCTIONAL so `advanced` hydrates. */
function stub(opts: { advanced?: boolean } = {}) {
  return `
(() => {
  const canned = (msg) => {
    const a = msg && msg.action;
    if (a === 'getLockState') return { lockState: 'unlocked' };
    if (a === 'getCustodyBalances') return { balances: { xch: 5000000000000, cats: {} } };
    if (a === 'getReceiveAddress') return { address: 'xch1qqqqdigsendreceivetriodemoqqqqqqqqqqqqqqqqqqqqqqqqqqqqqzz' };
    if (a === 'getActivity') return { events: [] };
    if (a === 'prepareSend') {
      const memoText = msg.memo || undefined;
      return { pendingId: 'p1', summary: { asset: 'XCH', sent: '250000000000', change: '4749000000000', fee: '0', recipientPuzzleHashHex: 'ab', coinCount: 1, ...(memoText ? { memoText } : {}) } };
    }
    if (a === 'confirmSend') return { spentCoinId: 'coin1' };
    if (a === 'sendStatus') return { confirmed: true };
    if (a === 'listDerivedAddresses') {
      const count = msg.count || 5;
      const addrs = [];
      for (let i = 0; i < count; i++) {
        addrs.push({ index: i, scheme: 'unhardened', address: 'xch1unh' + i + 'q'.repeat(50) });
        addrs.push({ index: i, scheme: 'hardened', address: 'xch1hrd' + i + 'q'.repeat(50) });
      }
      return { addresses: addrs };
    }
    return { success: true };
  };
  const store = { 'wallet.settings': ${JSON.stringify({ locale: 'en', advanced: !!opts.advanced })} };
  const changeListeners = new Set();
  const pick = (keys) => {
    if (keys == null) return { ...store };
    if (typeof keys === 'string') return store[keys] !== undefined ? { [keys]: store[keys] } : {};
    if (Array.isArray(keys)) { const o = {}; for (const k of keys) if (store[k] !== undefined) o[k] = store[k]; return o; }
    return { ...store };
  };
  window.chrome = {
    runtime: {
      id: 'send-receive-trio-harness',
      sendMessage: (msg, cb) => { const r = canned(msg); if (typeof cb === 'function') { cb(r); return; } return Promise.resolve(r); },
      getURL: (p) => p,
      onMessage: { addListener() {}, removeListener() {} },
      openOptionsPage() {},
      getManifest: () => ({ version: '0.0.0-e2e' }),
    },
    storage: {
      local: {
        get: (keys, cb) => { const r = pick(keys); if (typeof cb === 'function') { cb(r); return; } return Promise.resolve(r); },
        set: (obj, cb) => {
          const changes = {};
          for (const k of Object.keys(obj)) { changes[k] = { oldValue: store[k], newValue: obj[k] }; store[k] = obj[k]; }
          changeListeners.forEach((fn) => { try { fn(changes, 'local'); } catch (e) {} });
          if (typeof cb === 'function') { cb(); return; } return Promise.resolve();
        },
        remove: (k, cb) => { delete store[k]; if (typeof cb === 'function') { cb(); return; } return Promise.resolve(); },
      },
      session: { get: () => Promise.resolve({}), set: () => Promise.resolve() },
      onChanged: { addListener: (fn) => changeListeners.add(fn), removeListener: (fn) => changeListeners.delete(fn) },
    },
    tabs: { create() {} },
  };
})();
`;
}

async function openWallet(page: Page, file = 'popup.html', opts: { advanced?: boolean } = {}) {
  await page.addInitScript(stub(opts));
  await page.goto(`/${file}#wallet`);
  await expect(page.getByTestId('custody-wallet')).toBeVisible();
}

test.describe('#105 memo on send', () => {
  test('an optional memo reaches prepareSend and shows in review', async ({ page }) => {
    await openWallet(page, 'app.html'); // memo is available on both surfaces; use fullscreen for room
    await page.getByTestId('action-send').click();
    await expect(page.getByTestId('custody-send')).toBeVisible();

    await page.getByTestId('send-recipient').fill(RECIPIENT_ADDR);
    await page.getByTestId('send-amount').fill('0.25');
    await page.getByTestId('send-memo').fill('thanks for the coffee');
    await page.getByTestId('send-review').click();

    await expect(page.getByTestId('review-memo')).toHaveText('thanks for the coffee');
  });

  test('leaving the memo blank omits it from review', async ({ page }) => {
    await openWallet(page, 'popup.html');
    await page.getByTestId('action-send').click();
    await page.getByTestId('send-recipient').fill(RECIPIENT_ADDR);
    await page.getByTestId('send-amount').fill('0.25');
    await page.getByTestId('send-review').click();
    await expect(page.getByTestId('send-review-panel')).toBeVisible();
    await expect(page.getByTestId('review-memo')).toHaveCount(0);
  });

  for (const [label, file, size] of [
    ['popup', 'popup.html', { width: 372, height: 700 }],
    ['fullscreen', 'app.html', { width: 1200, height: 900 }],
  ] as const) {
    test(`screenshot: Send form with memo field (${label})`, async ({ page }) => {
      await page.setViewportSize(size);
      await openWallet(page, file);
      await page.getByTestId('action-send').click();
      await page.getByTestId('send-recipient').fill(RECIPIENT_ADDR);
      await page.getByTestId('send-amount').fill('0.25');
      await page.getByTestId('send-memo').fill('for the coffee');
      await page.waitForTimeout(200);
      await page.screenshot({ path: `e2e/__screenshots__/send-memo-${label}.png` });
    });

    test(`screenshot: Send review with memo (${label})`, async ({ page }) => {
      await page.setViewportSize(size);
      await openWallet(page, file);
      await page.getByTestId('action-send').click();
      await page.getByTestId('send-recipient').fill(RECIPIENT_ADDR);
      await page.getByTestId('send-amount').fill('0.25');
      await page.getByTestId('send-memo').fill('for the coffee');
      await page.getByTestId('send-review').click();
      await expect(page.getByTestId('review-memo')).toBeVisible();
      await page.waitForTimeout(200);
      await page.screenshot({ path: `e2e/__screenshots__/send-review-memo-${label}.png` });
    });
  }
});

test.describe('#106 derived-address list', () => {
  test('the Advanced list shows both HD schemes and "Show more" extends the page', async ({ page }) => {
    await openWallet(page, 'app.html', { advanced: true });
    await expect(page.getByTestId('derived-addresses')).toBeVisible();
    await expect(page.getByTestId('derived-address-unhardened-0')).toBeVisible();
    await expect(page.getByTestId('derived-address-hardened-0')).toBeVisible();
    await expect(page.getByTestId('derived-address-unhardened-4')).toBeVisible();
    await expect(page.getByTestId('derived-address-unhardened-5')).toHaveCount(0);

    await page.getByTestId('derived-addresses-more').click();
    await expect(page.getByTestId('derived-address-unhardened-9')).toBeVisible();
    // Earlier rows stay — "generate fresh" extends the page, never replaces it.
    await expect(page.getByTestId('derived-address-unhardened-0')).toBeVisible();
  });

  test('is hidden outside Advanced mode', async ({ page }) => {
    await openWallet(page, 'app.html', { advanced: false });
    await expect(page.getByTestId('derived-addresses')).toHaveCount(0);
  });

  test('Copy copies the full address to the clipboard', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openWallet(page, 'app.html', { advanced: true });
    await page.getByTestId('derived-address-copy-unhardened-0').click();
    await expect(page.getByTestId('derived-address-copy-unhardened-0')).toHaveText(/copied/i);
  });

  for (const [label, file, size] of [
    ['popup', 'popup.html', { width: 372, height: 900 }],
    ['fullscreen', 'app.html', { width: 1200, height: 1000 }],
  ] as const) {
    test(`screenshot: derived-address list (${label})`, async ({ page }) => {
      await page.setViewportSize(size);
      await openWallet(page, file, { advanced: true });
      const section = page.getByTestId('derived-addresses');
      await expect(section).toBeVisible();
      // The popup is a FIXED-HEIGHT 600px window (`.dig-app[data-layout='compact']`, the real Chrome
      // popup constraint) whose ONLY scroll container is the inner content area — `fullPage`
      // screenshots the outer (non-growing) document, so the Advanced section (below the fold) must
      // be scrolled into view first, exactly as a real user would scroll the popup to reach it.
      await section.scrollIntoViewIfNeeded();
      await page.waitForTimeout(200);
      await page.screenshot({ path: `e2e/__screenshots__/derived-addresses-${label}.png` });
    });
  }
});

test.describe('#107 QR camera scanner', () => {
  test('fullscreen-only: the popup never renders the Scan button', async ({ page }) => {
    await openWallet(page, 'popup.html');
    await page.getByTestId('action-send').click();
    await expect(page.getByTestId('send-scan-qr')).toHaveCount(0);
  });

  test('camera-permission path handled gracefully (no permission granted in this headless context)', async ({ page }) => {
    await openWallet(page, 'app.html');
    await page.getByTestId('action-send').click();
    await page.getByTestId('send-scan-qr').click();
    await expect(page.getByTestId('qr-scanner')).toBeVisible();
    // Headless Chromium with no camera permission granted and no real device rejects
    // getUserMedia — the scanner must render a graceful, actionable error, never a blank/broken view.
    await expect(page.getByTestId('qr-scanner-error')).toBeVisible({ timeout: 10_000 });
    // Cancel always works, even from the error state.
    await page.getByTestId('qr-scanner-cancel').click();
    await expect(page.getByTestId('send-recipient')).toBeVisible();
  });

  test('screenshot: graceful camera-error state (fullscreen)', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 900 });
    await openWallet(page, 'app.html');
    await page.getByTestId('action-send').click();
    await page.getByTestId('send-scan-qr').click();
    await expect(page.getByTestId('qr-scanner-error')).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(200);
    await page.screenshot({ path: 'e2e/__screenshots__/qr-scanner-error-fullscreen.png' });
  });
});
