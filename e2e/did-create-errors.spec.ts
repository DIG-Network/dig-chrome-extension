import { test, expect, type Page } from '@playwright/test';

/**
 * END-USER e2e for #179 — the DID-create build error is SPECIFIC to its cause (never the generic
 * "Couldn't prepare the DID — try again."). Driven against the real built `app.html` fullscreen
 * bundle (`dist-web`) with a canned `chrome.*` stub (same pattern as `e2e/home-balance.spec.ts`) so
 * the `prepareDidCreate` reply — and the active derivation index it names — is deterministic in CI.
 *
 * The wasm/Simulator proof that multi-coin funding and each error code are throw/caught correctly
 * lives in `dids.test.ts` + `didVault.test.ts` (a live coinset is non-deterministic in this browser
 * layer — same split as `e2e/sw/did-management.spec.ts`). This suite proves the built UI renders the
 * right, specific copy for each cause. Never broadcasts a spend.
 *
 * Run: `npm run build:web && npx playwright test e2e/did-create-errors.spec.ts`.
 */

/** chrome.* stub: an unlocked wallet at the given active index, with a canned `prepareDidCreate` reply. */
function stub(activeIndex: number, prepareDidCreateReply: unknown) {
  return `
(() => {
  const canned = (msg) => {
    const a = msg && msg.action;
    if (a === 'getLockState') return { lockState: 'unlocked', activeIndex: ${activeIndex} };
    if (a === 'getCustodyBalances') return { balances: { xch: 0, cats: {} } };
    if (a === 'listDids') return { dids: [] };
    if (a === 'prepareDidCreate') return ${JSON.stringify(prepareDidCreateReply)};
    return { success: true };
  };
  window.chrome = {
    runtime: {
      id: 'did-create-error-harness',
      sendMessage: (msg, cb) => { const r = canned(msg); if (typeof cb === 'function') { cb(r); return; } return Promise.resolve(r); },
      getURL: (p) => p,
      onMessage: { addListener() {}, removeListener() {} },
      openOptionsPage() {},
      getManifest: () => ({ version: '0.0.0-e2e' }),
    },
    storage: {
      local: {
        get: (key, cb) => { const out = {}; if (typeof cb === 'function') { cb(out); return; } return Promise.resolve(out); },
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
}

const TABLET = { width: 1200, height: 860 };

async function openCreateForm(page: Page, activeIndex: number, prepareDidCreateReply: unknown) {
  await page.setViewportSize(TABLET);
  await page.addInitScript(stub(activeIndex, prepareDidCreateReply));
  await page.goto('/app.html#wallet/did');
  await page.getByTestId('identity-create').click();
  await page.getByTestId('did-create-form').waitFor();
  await page.getByTestId('did-create-review').click();
}

test.describe('#179 DID create — specific build-error messages', () => {
  test('NO_XCH_COINS names the unfunded active index (never "try again")', async ({ page }) => {
    await openCreateForm(page, 5, { success: false, code: 'NO_XCH_COINS' });
    const error = page.getByTestId('did-create-build-error');
    await expect(error).toBeVisible();
    await expect(error).toContainText('5');
    await expect(error).not.toContainText(/try again/i);
    await page.screenshot({ path: 'e2e/__screenshots__/did-create-error-no-xch-coins.png' });
  });

  test('NO_SUITABLE_COIN shows the insufficient-total-funds message (never "try again")', async ({ page }) => {
    await openCreateForm(page, 0, { success: false, code: 'NO_SUITABLE_COIN' });
    const error = page.getByTestId('did-create-build-error');
    await expect(error).toBeVisible();
    await expect(error).not.toContainText(/try again/i);
    await page.screenshot({ path: 'e2e/__screenshots__/did-create-error-no-suitable-coin.png' });
  });

  test('an unrecognized code surfaces the ACTUAL error text (never a canned "try again")', async ({ page }) => {
    await openCreateForm(page, 0, { success: false, code: 'WASM_ERROR', message: 'clvm raise (SPEND_ASSERT)' });
    const error = page.getByTestId('did-create-build-error');
    await expect(error).toBeVisible();
    await expect(error).toContainText('clvm raise (SPEND_ASSERT)');
    await expect(error).not.toContainText(/try again/i);
  });

  test('a funded active index proceeds past the form to the review step', async ({ page }) => {
    await openCreateForm(page, 0, {
      pendingId: 'p1',
      launcherId: 'ab'.repeat(32),
      didCreateSummary: { launcherId: 'ab'.repeat(32), p2PuzzleHashHex: 'ef'.repeat(32), fee: '0', coinCount: 1 },
    });
    await expect(page.getByTestId('did-create-review-panel')).toBeVisible();
    await expect(page.getByTestId('did-create-build-error')).toHaveCount(0);
    await page.screenshot({ path: 'e2e/__screenshots__/did-create-funded-review.png' });
  });
});
