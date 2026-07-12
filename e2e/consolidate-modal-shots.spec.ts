import { test, expect, type Page } from '@playwright/test';

/**
 * SCREENSHOT harness for the #417 auto-consolidate modal, driven against the REAL built popup +
 * fullscreen bundles (dist-web) with a canned `chrome.runtime.sendMessage`: `prepareSend` returns
 * the coded `NEEDS_CONSOLIDATION` (a coin-fragmented wallet), so the send flow builds the
 * consolidation quote (`prepareConsolidation`) and shows the honest, dismissible combine modal.
 *
 * Run: `npm run build:web && npx playwright test e2e/consolidate-modal-shots.spec.ts`.
 */

const RECIPIENT_ADDR = 'xch1qgp8xdq8lrsrljezregl9xk8ymw4x0h2z9m0j8zq0k7q9m8x0hqsm3g4tl';

function stub() {
  return `
(() => {
  const canned = (msg) => {
    const a = msg && msg.action;
    if (a === 'getLockState') return { lockState: 'unlocked' };
    if (a === 'getCustodyBalances') return { balances: { xch: 9000000000000, cats: {} } };
    if (a === 'getReceiveAddress') return { address: 'xch1qqqqdigconsolidatedemoqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqzz' };
    if (a === 'getActivity') return { events: [] };
    // A coin-fragmented wallet: the first prepareSend fails NEEDS_CONSOLIDATION (drives the modal).
    if (a === 'prepareSend') return { success: false, code: 'NEEDS_CONSOLIDATION', message: 'NEEDS_CONSOLIDATION: too many small coins' };
    // The keyless combine quote shown in the modal (merge 50 of the smallest coins).
    if (a === 'prepareConsolidation') return { pendingId: 'c1', coinOpSummary: { asset: 'XCH', kind: 'combine', inputCoinCount: 50, outputCoinCount: 1, total: '5000000', fee: '1000000' } };
    if (a === 'confirmSend') return { spentCoinId: 'combineCoin' };
    if (a === 'sendStatus') return { confirmed: false }; // stays 'confirming' for the progress shot
    return { success: true };
  };
  const store = { 'wallet.settings': ${JSON.stringify({ locale: 'en' })} };
  const changeListeners = new Set();
  const pick = (keys) => {
    if (keys == null) return { ...store };
    if (typeof keys === 'string') return store[keys] !== undefined ? { [keys]: store[keys] } : {};
    if (Array.isArray(keys)) { const o = {}; for (const k of keys) if (store[k] !== undefined) o[k] = store[k]; return o; }
    return { ...store };
  };
  window.chrome = {
    runtime: {
      id: 'consolidate-shots-harness',
      sendMessage: (msg, cb) => { const r = canned(msg); if (typeof cb === 'function') { cb(r); return; } return Promise.resolve(r); },
      getURL: (p) => p,
      onMessage: { addListener() {}, removeListener() {} },
      openOptionsPage() {},
      getManifest: () => ({ version: '0.0.0-e2e' }),
    },
    storage: {
      local: {
        get: (keys, cb) => { const r = pick(keys); if (typeof cb === 'function') { cb(r); return; } return Promise.resolve(r); },
        set: (obj, cb) => { for (const k of Object.keys(obj)) store[k] = obj[k]; if (typeof cb === 'function') { cb(); return; } return Promise.resolve(); },
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

async function openSend(page: Page, file: string) {
  await page.addInitScript(stub());
  await page.goto(`/${file}#wallet`);
  await expect(page.getByTestId('custody-wallet')).toBeVisible();
  await page.getByTestId('action-send').click();
  await expect(page.getByTestId('custody-send')).toBeVisible();
  await page.getByTestId('send-recipient').fill(RECIPIENT_ADDR);
  await page.getByTestId('send-amount').fill('1.5');
  await page.getByTestId('send-review').click();
}

for (const [label, file, size] of [
  ['popup', 'popup.html', { width: 372, height: 700 }],
  ['fullscreen', 'app.html', { width: 1200, height: 900 }],
] as const) {
  test(`screenshot: auto-consolidate PROMPT (${label})`, async ({ page }) => {
    await page.setViewportSize(size);
    await openSend(page, file);
    await expect(page.getByTestId('consolidate-prompt')).toBeVisible();
    await page.waitForTimeout(250);
    await page.screenshot({ path: `e2e/__screenshots__/consolidate-prompt-${label}.png` });
  });

  test(`screenshot: auto-consolidate PROGRESS (${label})`, async ({ page }) => {
    await page.setViewportSize(size);
    await openSend(page, file);
    await expect(page.getByTestId('consolidate-prompt')).toBeVisible();
    await page.getByTestId('consolidate-confirm').click();
    await expect(page.getByTestId('consolidate-progress')).toBeVisible();
    await page.waitForTimeout(250);
    await page.screenshot({ path: `e2e/__screenshots__/consolidate-progress-${label}.png` });
  });
}
