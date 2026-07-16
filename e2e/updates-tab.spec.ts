import { test, expect, type Page } from '@playwright/test';

/**
 * End-user e2e + screenshots for the fullscreen Updates tab (#504-K/#516, child of epic #504). Serves
 * the real built `app.html` over the static harness with a stubbed `chrome.*` that answers the
 * `getControlStatus` (node online), `pairingState` (paired, so the panel shows), the `controlAuthed`
 * proxy for `control.updater.status` / `.pause` / `.resume` / `.checkNow`, and `getNodeLiveStatus`
 * (the running dig-node's own version, #239) — the SAME dig-node wire contracts the real extension
 * drives — plus a routed `updates.dig.net` feed-manifest response for {@link NodeVersionSection}
 * (#583). Proves the tab renders the beacon readout, the pause/resume toggle flips, check-now
 * surfaces its own recoverable error on a decline, the beacon-absent case renders a graceful empty
 * state rather than an error wall, AND the running dig-node version + its out-of-date badge render
 * distinctly from the beacon version (up-to-date, update-available, node-offline, and
 * feed-unreachable — never a false "up to date"). Output → e2e/__screenshots__/.
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

/** The running dig-node's own live status (#239's `getNodeLiveStatus`) — defaults to a connected
 *  node whose version matches the feed default below (an "up to date" verdict). */
const NODE_LIVE_CONNECTED = { state: 'connected', base: 'https://dig.local', addr: '127.0.0.1:9778', version: '0.31.1', commit: 'abc123', updatedAt: 0 };

function stub(beacon: unknown, nodeLiveStatus: unknown = NODE_LIVE_CONNECTED): string {
  return `
(() => {
  const BEACON = ${JSON.stringify(beacon)};
  const NODE_LIVE_STATUS = ${JSON.stringify(nodeLiveStatus)};
  const canned = (msg) => {
    const a = msg && msg.action;
    if (a === 'getLockState') return { lockState: 'unlocked' };
    if (a === 'getControlStatus') return { mode: 'manage', localNode: true, base: 'https://dig.local', controlEndpoint: 'https://dig.local/', readFallback: 'https://rpc.dig.net', status: {}, authRequired: false, controlMethods: [] };
    if (a === 'pairingState') return { phase: 'paired' };
    if (a === 'getNodeLiveStatus') return NODE_LIVE_STATUS;
    if (a === 'controlAuthed') {
      const m = msg.method;
      if (m === 'control.updater.status') return BEACON;
      if (m === 'control.updater.pause') { if (BEACON.installed) BEACON.status.paused = true; return { ok: true }; }
      if (m === 'control.updater.resume') { if (BEACON.installed) BEACON.status.paused = false; return { ok: true }; }
      if (m === 'control.updater.checkNow') return { success: false, error: 'dig-updater declined the request' };
      if (m === 'control.updater.setChannel') {
        const ch = msg.params && msg.params.channel;
        (window.__setChannelCalls = window.__setChannelCalls || []).push(ch);
        if (BEACON.installed) BEACON.status.channel = ch;
        return { ok: true };
      }
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

/** The feed's advertised dig-node version — 'unreachable' simulates the feed being down (network
 *  error), matching how `fetchFeedComponents` classifies it (feed-manifest.ts). */
async function routeFeedManifest(page: Page, latestDigNodeVersion: string | 'unreachable') {
  // Match ANY per-channel manifest path (#606): the badge fetches `/v1/<tracked-channel>/manifest.json`
  // — `stable` or `nightly` (`alpha` maps onto nightly) — so route the whole family to one fixture.
  await page.route('**/v1/*/manifest.json', (route) => {
    if (latestDigNodeVersion === 'unreachable') return route.abort('failed');
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ manifest: { components: [{ name: 'dig-node', version: latestDigNodeVersion }] } }),
    });
  });
}

async function open(
  page: Page,
  opts: { beacon?: unknown; nodeLiveStatus?: unknown; feedDigNodeVersion?: string | 'unreachable' } = {},
) {
  const { beacon = BEACON, nodeLiveStatus = NODE_LIVE_CONNECTED, feedDigNodeVersion = '0.31.1' } = opts;
  await page.addInitScript(stub(beacon, nodeLiveStatus));
  await page.route('**/store.json', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ apps: [] }) }));
  await routeFeedManifest(page, feedDigNodeVersion);
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
  // The channel is now a switcher; the fixture's legacy `alpha` maps onto the `nightly` option (#606).
  await expect(page.getByTestId('updates-channel-select')).toHaveValue('nightly');
  await expect(page.getByTestId('updates-component-row')).toHaveCount(3);
  await expect(page.getByTestId('updates-pause')).toBeVisible();
  await expect(page.getByTestId('updates-check-now')).toBeVisible();
  // The running dig-node version (#583) sits ABOVE the beacon panel, distinctly labeled + "up to
  // date" (the fixture's node version 0.31.1 matches the fixture's feed version).
  await expect(page.getByTestId('updates-node-version-value')).toHaveText('dig-node v0.31.1');
  await expect(page.getByTestId('updates-node-version-badge')).toHaveText('Up to date');
  await expect(page.getByTestId('updates-version')).toHaveText('Beacon v0.6.0'); // never conflated
  await page.screenshot({ path: 'e2e/__screenshots__/fullscreen-updates.png', fullPage: true });
});

test('Updates tab (#583) — an out-of-date dig-node shows "Update available — vX.Y.Z"', async ({ page }) => {
  await page.setViewportSize(TABLET);
  await open(page, { nodeLiveStatus: { ...NODE_LIVE_CONNECTED, version: '0.30.0' }, feedDigNodeVersion: '0.31.1' });
  await expect(page.getByTestId('updates-node-version-value')).toHaveText('dig-node v0.30.0');
  await expect(page.getByTestId('updates-node-version-badge')).toHaveText('Update available — v0.31.1');
  await page.screenshot({ path: 'e2e/__screenshots__/updates-node-outdated.png', fullPage: true });
});

test('Updates tab (#583) — the feed being unreachable shows "couldn\'t check", never a false "up to date"', async ({ page }) => {
  await page.setViewportSize(TABLET);
  await open(page, { feedDigNodeVersion: 'unreachable' });
  // The running version still renders — losing the feed must not hide what we DO know.
  await expect(page.getByTestId('updates-node-version-value')).toHaveText('dig-node v0.31.1');
  await expect(page.getByTestId('updates-node-version-badge')).toHaveText("Couldn't check for updates");
});

test('Updates tab (#583) — a disconnected dig-node shows "Node offline", never a false "up to date"', async ({ page }) => {
  await page.setViewportSize(TABLET);
  await open(page, { nodeLiveStatus: { state: 'disconnected', base: null, addr: null, version: null, commit: null, updatedAt: 0 } });
  await expect(page.getByTestId('updates-node-version-badge')).toHaveText('Node offline');
  await expect(page.getByTestId('updates-node-version-value')).toHaveCount(0);
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
  await open(page, { beacon: { installed: false } });
  await expect(page.getByTestId('updates-status-empty')).toBeVisible();
  await expect(page.getByTestId('updates-status-error')).toHaveCount(0);
  await page.screenshot({ path: 'e2e/__screenshots__/updates-not-installed.png', fullPage: true });
});

test('Updates tab (#606) — switches the update channel via control.updater.setChannel', async ({ page }) => {
  await page.setViewportSize(TABLET);
  await open(page);
  const select = page.getByTestId('updates-channel-select');
  // Starts on nightly (the fixture's `alpha` alias); switch to stable.
  await expect(select).toHaveValue('nightly');
  await select.selectOption('stable');
  // The refreshed status (setChannel mutated the fixture) flips the switcher to the persisted value,
  // and the exact token was forwarded to the node proxy verbatim.
  await expect(select).toHaveValue('stable');
  const calls = await page.evaluate(() => (window as unknown as { __setChannelCalls?: string[] }).__setChannelCalls ?? []);
  expect(calls).toEqual(['stable']);
  await settlePaint(page);
  await page.screenshot({ path: 'e2e/__screenshots__/updates-channel-switcher.png', fullPage: true });
});

test('Updates tab — mobile width layout', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await open(page);
  await expect(page.getByTestId('updates-panel')).toBeVisible();
  await expect(page.getByTestId('updates-controls')).toBeVisible();
  await expect(page.getByTestId('updates-node-version-badge')).toHaveText('Up to date');
  await page.screenshot({ path: 'e2e/__screenshots__/mobile-updates.png', fullPage: true });
});
