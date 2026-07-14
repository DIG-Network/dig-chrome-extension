import { test, expect, type Page } from '@playwright/test';

/**
 * End-user e2e + screenshots for the fullscreen Updates tab (#504-K/#516, child of epic #504). Serves
 * the real built `app.html` over the static harness with a stubbed `chrome.*` that answers the
 * `getControlStatus` (node online), `pairingState` (paired, so the panel shows), and the
 * `controlAuthed` proxy for `control.updater.status` / `.pause` / `.resume` / `.checkNow` — the SAME
 * dig-node #515 wire contract the real extension drives. Proves the tab renders the beacon readout,
 * the pause/resume toggle flips, check-now surfaces its own recoverable error on a decline, and the
 * beacon-absent case renders a graceful empty state rather than an error wall. Output →
 * e2e/__screenshots__/.
 */

/** A mutable beacon status the stub mutates as the UI drives pause/resume (mirrors the real
 *  dig-updater CLI's status.json refresh-after-every-mutation behavior, dig-updater SPEC §13.2). */
const BEACON = {
  installed: true,
  status: {
    schema: 1,
    version: '0.6.0',
    channel: 'alpha',
    paused: false,
    paused_until: null,
    last_check: 1730990000,
    last_check_kind: 'run',
    last_outcome: 'applied',
    last_reason: null,
    last_detail: null,
    components: [
      { component: 'dig-node', action: 'update', result: 'installed', detail: '0.25.0 -> 0.26.0' },
      { component: 'digstore', action: 'skip', result: 'skipped', detail: 'already current' },
      { component: 'dig-updater', action: 'skip', result: 'skipped', detail: 'already current' },
    ],
    next_wake: 1731076400,
  },
};

function stub(beacon: unknown): string {
  return `
(() => {
  const BEACON = ${JSON.stringify(beacon)};
  const canned = (msg) => {
    const a = msg && msg.action;
    if (a === 'getLockState') return { lockState: 'unlocked' };
    if (a === 'getControlStatus') return { mode: 'manage', localNode: true, base: 'https://dig.local', controlEndpoint: 'https://dig.local/', readFallback: 'https://rpc.dig.net', status: {}, authRequired: false, controlMethods: [] };
    if (a === 'pairingState') return { phase: 'paired' };
    if (a === 'controlAuthed') {
      const m = msg.method;
      if (m === 'control.updater.status') return BEACON;
      if (m === 'control.updater.pause') { if (BEACON.installed) BEACON.status.paused = true; return { ok: true }; }
      if (m === 'control.updater.resume') { if (BEACON.installed) BEACON.status.paused = false; return { ok: true }; }
      if (m === 'control.updater.checkNow') return { success: false, error: 'dig-updater declined the request' };
      return { success: true };
    }
    return { success: true };
  };
  window.chrome = {
    runtime: {
      id: 'updates-tab-harness',
      sendMessage: (msg, cb) => { const r = canned(msg); if (typeof cb === 'function') { cb(r); return; } return Promise.resolve(r); },
      getURL: (p) => p,
      onMessage: { addListener() {}, removeListener() {} },
      openOptionsPage() {},
      getManifest: () => ({ version: '1.99.0' }),
    },
    commands: { getAll: (cb) => cb([]) },
    storage: {
      local: {
        get: (keys, cb) => { const r = {}; if (typeof cb === 'function') { cb(r); return; } return Promise.resolve(r); },
        set: (o, cb) => { if (typeof cb === 'function') { cb(); return; } return Promise.resolve(); },
        remove: (k, cb) => { if (typeof cb === 'function') { cb(); return; } return Promise.resolve(); },
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

async function open(page: Page, beacon: unknown = BEACON) {
  await page.addInitScript(stub(beacon));
  await page.route('**/store.json', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ apps: [] }) }));
  await page.goto('/app.html#updates');
  await page.getByTestId('updates-tab-panel').waitFor();
  await page.waitForTimeout(300);
  await settlePaint(page);
}

/** Let the `.dig-screen` mount transition (`dig-screen-enter`, 220ms) fully composite before a
 *  screenshot — a bare `waitForTimeout` alone can still race Chromium's paint pipeline on a page
 *  tall enough to need `fullPage` stitching, leaving a stale, washed-out layer in the capture even
 *  though the DOM's computed styles are already final. Two nested rAFs guarantee at least one full
 *  paint has committed after the timer fires. */
async function settlePaint(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

const PHONE = { width: 372, height: 720 };
const TABLET = { width: 1200, height: 900 };

test('fullscreen Updates tab — renders the beacon readout + controls (desktop)', async ({ page }) => {
  await page.setViewportSize(TABLET);
  await open(page);
  await expect(page.getByTestId('updates-panel')).toBeVisible();
  await expect(page.getByTestId('updates-channel')).toHaveText('alpha');
  await expect(page.getByTestId('updates-component-row')).toHaveCount(3);
  await expect(page.getByTestId('updates-pause')).toBeVisible();
  await expect(page.getByTestId('updates-check-now')).toBeVisible();
  await page.screenshot({ path: 'e2e/__screenshots__/fullscreen-updates.png', fullPage: true });
});

test('Updates tab — the pause control flips to resume once the node reports paused', async ({ page }) => {
  await page.setViewportSize(TABLET);
  await open(page);
  await page.getByTestId('updates-pause').click();
  await expect(page.getByTestId('updates-resume')).toBeVisible();
  await expect(page.getByTestId('updates-pause')).toHaveCount(0);
});

test('Updates tab — a declined check-now surfaces a recoverable inline error, not a blank failure', async ({ page }) => {
  await page.setViewportSize(TABLET);
  await open(page);
  await page.getByTestId('updates-check-now').click();
  await expect(page.getByTestId('updates-action-error')).toBeVisible();
});

test('Updates tab — beacon-absent renders a graceful empty state, never an error wall', async ({ page }) => {
  await page.setViewportSize(TABLET);
  await open(page, { installed: false });
  await expect(page.getByTestId('updates-status-empty')).toBeVisible();
  await expect(page.getByTestId('updates-status-error')).toHaveCount(0);
  await page.screenshot({ path: 'e2e/__screenshots__/updates-not-installed.png', fullPage: true });
});

test('Updates tab — mobile width layout', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await open(page);
  await expect(page.getByTestId('updates-panel')).toBeVisible();
  await expect(page.getByTestId('updates-controls')).toBeVisible();
  await page.screenshot({ path: 'e2e/__screenshots__/mobile-updates.png', fullPage: true });
});
