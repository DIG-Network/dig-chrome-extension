import { test, expect, type Page } from '@playwright/test';

/**
 * END-USER e2e for #312 — the "Open a chia:// address or DIG URN" input docked FLUSH to the top of
 * the Home tab (edge-to-edge, no margins), driven against the REAL built popup + fullscreen bundles
 * (`dist-web`) with a canned `chrome.*` stub. Proves the input is the TOP-most Home element and reads
 * as a docked bar (zero side margin, top flush against the scroll area) rather than a floating card.
 *
 * (The DIG toolbar enable/disable toggle moved OUT of the Home tab into the window header in #306 —
 * its coverage lives in the SW harness's #306 tests; this spec covers the Home tab's own top element.)
 *
 * Run: `npm run build:web && npx playwright test e2e/home-flush-urn.spec.ts`.
 */

/** chrome.* stub: an unlocked wallet with no balances, so Home renders the widget board fast. */
function stub() {
  return `
(() => {
  const canned = (msg) => {
    const a = msg && msg.action;
    if (a === 'getLockState') return { lockState: 'unlocked', activeWalletId: 'w1', activeIndex: 0 };
    if (a === 'getCustodyBalances') return { balances: { xch: 0, cats: {} } };
    if (a === 'getActivity') return { events: [], cursorHeight: 0 };
    if (a === 'getDigNodeStatus') return { reachable: false, base: null };
    if (a === 'getDigDnsStatus') return { phase: 'unavailable' };
    return { success: true };
  };
  window.chrome = {
    runtime: {
      id: 'home-flush-urn-harness',
      sendMessage: (msg, cb) => { const r = canned(msg); if (typeof cb === 'function') { cb(r); return; } return Promise.resolve(r); },
      getURL: (p) => p,
      onMessage: { addListener() {}, removeListener() {} },
      openOptionsPage() {},
      getManifest: () => ({ version: '0.0.0-e2e' }),
    },
    storage: {
      local: {
        get: (keys, cb) => { const r = {}; if (typeof cb === 'function') { cb(r); return; } return Promise.resolve(r); },
        set: (_obj, cb) => { if (typeof cb === 'function') { cb(); return; } return Promise.resolve(); },
        remove: (_k, cb) => { if (typeof cb === 'function') { cb(); return; } return Promise.resolve(); },
      },
      session: { get: () => Promise.resolve({}), set: () => Promise.resolve() },
      onChanged: { addListener() {}, removeListener() {} },
    },
    tabs: { create() {} },
  };
})();
`;
}

async function open(page: Page, file: string) {
  await page.addInitScript(stub());
  await page.goto(`/${file}#home`);
}

test.describe('#312 Home flush-top URN input', () => {
  test('is the FIRST element on Home and carries the flush docked class', async ({ page }) => {
    await open(page, 'popup.html');
    await expect(page.getByTestId('home-screen')).toBeVisible();
    const first = page.getByTestId('home-screen').locator(':scope > *').first();
    await expect(first).toHaveAttribute('data-testid', 'home-openurn');
    await expect(page.getByTestId('home-openurn')).toHaveClass(/dig-openurn--flush/);
    await expect(page.getByTestId('home-openurn-input')).toBeVisible();
  });

  test('the input strip is edge-to-edge — no side gap against the popup viewport', async ({ page }) => {
    await page.setViewportSize({ width: 372, height: 640 });
    await open(page, 'popup.html');
    const bar = page.getByTestId('home-openurn');
    await expect(bar).toBeVisible();
    const box = await bar.boundingBox();
    // Docked flush: the bar's left edge sits at the viewport's left edge (no card margin).
    expect(box).not.toBeNull();
    expect(box!.x).toBeLessThanOrEqual(1);
  });

  for (const [label, file, size] of [
    ['popup', 'popup.html', { width: 372, height: 640 }],
    ['fullscreen', 'app.html', { width: 1200, height: 860 }],
  ] as const) {
    test(`screenshot: flush URN input at the top of Home (${label})`, async ({ page }) => {
      await page.setViewportSize(size);
      await open(page, file);
      await expect(page.getByTestId('home-openurn')).toBeVisible();
      await page.waitForTimeout(200);
      await page.screenshot({ path: `e2e/__screenshots__/home-flush-urn-${label}.png` });
    });
  }
});
