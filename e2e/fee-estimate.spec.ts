import { test, expect, type Page } from '@playwright/test';

/**
 * END-USER e2e for #206/#110 — the Send flow's bias-to-estimate network fee, driven against the
 * REAL built popup + fullscreen bundles (dist-web). Same pattern as e2e/send-receive-trio.spec.ts: a
 * canned `chrome.runtime.sendMessage` stub for the SW/vault (lock state, balances, prepareSend never
 * touches a real chain), plus `page.route` to intercept the real `fetch` to coinset.org's
 * `get_fee_estimate` (mirrors e2e/prices.spec.ts's price-source mocking) — so the fee math is fully
 * reproducible in CI with no live mempool. This exercises the real RTK Query `feeApi` slice + the
 * real `FeeField` component; only the network response is mocked.
 *
 * Run: `npm run build:web && npx playwright test e2e/fee-estimate.spec.ts`.
 */

const RECIPIENT_ADDR = 'xch1qgp8xdq8lrsrljezregl9xk8ymw4x0h2z9m0j8zq0k7q9m8x0hqsm3g4tl';

/** chrome.* stub: an unlocked wallet; prepareSend echoes back the chosen fee. */
const STUB = `
(() => {
  const canned = (msg) => {
    const a = msg && msg.action;
    if (a === 'getLockState') return { lockState: 'unlocked' };
    if (a === 'getCustodyBalances') return { balances: { xch: 5000000000000, cats: {} } };
    if (a === 'getReceiveAddress') return { address: 'xch1qqqqdigfeeestimatedemoqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqzzzz' };
    if (a === 'getActivity') return { events: [] };
    if (a === 'prepareSend') return { pendingId: 'p1', summary: { asset: 'XCH', sent: '250000000000', change: '4748999000000', fee: msg.fee || '0', recipientPuzzleHashHex: 'ab', coinCount: 1 } };
    if (a === 'confirmSend') return { spentCoinId: 'coin1' };
    if (a === 'sendStatus') return { confirmed: true };
    return { success: true };
  };
  window.chrome = {
    runtime: {
      id: 'fee-estimate-harness',
      sendMessage: (msg, cb) => { const r = canned(msg); if (typeof cb === 'function') { cb(r); return; } return Promise.resolve(r); },
      getURL: (p) => p,
      onMessage: { addListener() {}, removeListener() {} },
      openOptionsPage() {},
      getManifest: () => ({ version: '0.0.0-e2e' }),
    },
    storage: {
      local: {
        get: (keys, cb) => { const r = {}; if (typeof cb === 'function') { cb(r); return; } return Promise.resolve(r); },
        set: (o, cb) => { if (typeof cb === 'function') { cb(); return; } return Promise.resolve(); },
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

/** Fulfill a CORS-enabled JSON response (the popup fetches coinset.org cross-origin). */
function json(route: Parameters<Parameters<Page['route']>[1]>[0], body: unknown) {
  return route.fulfill({
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify(body),
  });
}

/** fast/normal/slow mojo estimates, aligned to feeEstimate.ts's requested target-time order. */
const ESTIMATES = [5_000_000_000, 1_000_000_000, 100_000_000]; // 0.005 / 0.001 / 0.0001 XCH

async function openSend(page: Page, file = 'popup.html') {
  await page.addInitScript(STUB);
  await page.goto(`/${file}#wallet`);
  await expect(page.getByTestId('custody-wallet')).toBeVisible();
  await page.getByTestId('action-send').click();
  await expect(page.getByTestId('custody-send')).toBeVisible();
}

test.describe('#206/#110 network-fee estimate + presets', () => {
  test('defaults to the coinset.org "normal" estimate as a read-only line item', async ({ page }) => {
    await page.route('https://api.coinset.org/get_fee_estimate', (r) => json(r, { estimates: ESTIMATES }));
    await openSend(page, 'app.html');

    const line = page.getByTestId('fee-line');
    await expect(line).toBeVisible();
    await expect(page.getByTestId('fee-line-amount')).toContainText('0.001'); // normal preset
    await expect(page.getByTestId('fee-line-amount')).toContainText('estimated');
    await expect(page.getByTestId('fee-override-toggle')).toBeVisible();
  });

  test('fast/normal/slow presets switch the shown fee, all from one estimate call', async ({ page }) => {
    let calls = 0;
    await page.route('https://api.coinset.org/get_fee_estimate', (r) => {
      calls += 1;
      return json(r, { estimates: ESTIMATES });
    });
    await openSend(page, 'app.html');
    await expect(page.getByTestId('fee-line')).toBeVisible();

    await page.getByTestId('fee-preset-fast').click();
    await expect(page.getByTestId('fee-line-amount')).toContainText('0.005');
    await page.getByTestId('fee-preset-slow').click();
    await expect(page.getByTestId('fee-line-amount')).toContainText('0.0001');

    expect(calls).toBe(1); // presets are derived client-side from the single estimate response
  });

  test('Override turns the line item into an editable input; "Use estimate" reverts it', async ({ page }) => {
    await page.route('https://api.coinset.org/get_fee_estimate', (r) => json(r, { estimates: ESTIMATES }));
    await openSend(page, 'app.html');
    await expect(page.getByTestId('fee-line')).toBeVisible();

    await page.getByTestId('fee-override-toggle').click();
    const input = page.getByTestId('fee-override-input');
    await expect(input).toBeVisible();
    await input.fill('0.02');
    await expect(input).toHaveValue('0.02');

    await page.getByTestId('fee-use-estimate').click();
    await expect(page.getByTestId('fee-line-amount')).toContainText('0.001'); // back to "normal"
  });

  test('an unreachable estimate falls back to a manual fee input with an honest note', async ({ page }) => {
    await page.route('https://api.coinset.org/get_fee_estimate', (r) => r.abort());
    await openSend(page, 'app.html');

    await expect(page.getByTestId('fee-error')).toBeVisible();
    await expect(page.getByTestId('fee-override-input')).toBeVisible();
  });

  // Visual capture (§6.5) — the fee field at phone (popup) + tablet (fullscreen) widths.
  for (const [label, file, size] of [
    ['popup', 'popup.html', { width: 372, height: 700 }],
    ['fullscreen', 'app.html', { width: 1200, height: 900 }],
  ] as const) {
    test(`screenshot: Send fee field (${label})`, async ({ page }) => {
      await page.route('https://api.coinset.org/get_fee_estimate', (r) => json(r, { estimates: ESTIMATES }));
      await page.setViewportSize(size);
      await openSend(page, file);
      await page.getByTestId('send-recipient').fill(RECIPIENT_ADDR);
      await page.getByTestId('send-amount').fill('0.25');
      const feeLine = page.getByTestId('fee-line');
      await expect(feeLine).toBeVisible();
      // The popup is a FIXED-HEIGHT 600px window whose only scroll container is the inner content
      // area — scroll the fee field into view first so it lands inside the captured viewport,
      // exactly as send-receive-trio.spec.ts does for the derived-address list below the fold.
      await feeLine.scrollIntoViewIfNeeded();
      await page.waitForTimeout(200);
      await page.screenshot({ path: `e2e/__screenshots__/send-fee-field-${label}.png` });
    });
  }
});
