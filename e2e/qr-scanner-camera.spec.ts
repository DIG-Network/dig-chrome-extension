import { test, expect, type Page } from '@playwright/test';

/**
 * END-USER e2e for #107 — the QR camera scanner, exercising a REAL (fake-device) camera stream
 * end-to-end: the ACTUAL `getUserMedia` → `<video>` → `requestAnimationFrame` scan-loop wiring runs
 * for real (nothing mocked), fed by Chromium's synthetic test-pattern video
 * (`--use-fake-device-for-media-stream`) with the permission prompt auto-accepted
 * (`--use-fake-ui-for-media-stream`). The synthetic feed is never a real decodable QR code, so the
 * loop keeps scanning — this proves the CAMERA INTEGRATION path (permission → stream → live
 * preview → clean teardown), while `qrScan.test.ts`/`QrScanner.test.tsx` already prove the DECODE
 * path with a mocked jsQR. `test.use({ launchOptions })` must be top-level in the file (Playwright
 * forces a fresh worker/browser per file for a launchOptions override — it cannot be scoped to a
 * `describe` block), hence this lives in its own spec file, separate from
 * `send-receive-trio.spec.ts`'s no-camera-permission graceful-error case.
 *
 * Run: `npm run build:web && npx playwright test e2e/qr-scanner-camera.spec.ts`.
 */

test.use({
  launchOptions: {
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  },
});

const STUB = `
(() => {
  const canned = (msg) => {
    const a = msg && msg.action;
    if (a === 'getLockState') return { lockState: 'unlocked' };
    if (a === 'getCustodyBalances') return { balances: { xch: 5000000000000, cats: {} } };
    if (a === 'getReceiveAddress') return { address: 'xch1qqqqdigqrscancameraqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqzzzz' };
    if (a === 'getActivity') return { events: [] };
    return { success: true };
  };
  window.chrome = {
    runtime: {
      id: 'qr-scanner-camera-harness',
      sendMessage: (msg, cb) => { const r = canned(msg); if (typeof cb === 'function') { cb(r); return; } return Promise.resolve(r); },
      getURL: (p) => p,
      onMessage: { addListener() {}, removeListener() {} },
      openOptionsPage() {},
      getManifest: () => ({ version: '0.0.0-e2e' }),
    },
    storage: {
      local: { get: (k, cb) => { const r = {}; if (typeof cb === 'function') { cb(r); return; } return Promise.resolve(r); }, set: (o, cb) => { if (typeof cb === 'function') { cb(); return; } return Promise.resolve(); }, remove: (k, cb) => { if (typeof cb === 'function') { cb(); return; } return Promise.resolve(); } },
      session: { get: () => Promise.resolve({}), set: () => Promise.resolve() },
      onChanged: { addListener() {}, removeListener() {} },
    },
    tabs: { create() {} },
  };
})();
`;

async function openWallet(page: Page, file = 'app.html') {
  await page.addInitScript(STUB);
  await page.goto(`/${file}#wallet`);
  await expect(page.getByTestId('custody-wallet')).toBeVisible();
}

test.describe('#107 QR camera scanner — live (fake) camera device', () => {
  test('a granted camera renders the live scanning preview, and Cancel stops it cleanly', async ({ page, context }) => {
    await context.grantPermissions(['camera']);
    await openWallet(page);
    await page.getByTestId('action-send').click();
    await page.getByTestId('send-scan-qr').click();
    await expect(page.getByTestId('qr-scanner-video')).toBeVisible({ timeout: 10_000 });

    await page.getByTestId('qr-scanner-cancel').click();
    await expect(page.getByTestId('send-recipient')).toBeVisible();
  });

  test('screenshot: live scanning preview (fullscreen)', async ({ page, context }) => {
    await context.grantPermissions(['camera']);
    await page.setViewportSize({ width: 1200, height: 900 });
    await openWallet(page);
    await page.getByTestId('action-send').click();
    await page.getByTestId('send-scan-qr').click();
    await expect(page.getByTestId('qr-scanner-video')).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(1500); // let the fake-device video pipeline paint at least one frame
    await page.screenshot({ path: 'e2e/__screenshots__/qr-scanner-live-fullscreen.png' });
  });
});
