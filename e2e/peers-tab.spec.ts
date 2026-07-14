import { test, expect, type Page } from '@playwright/test';

/**
 * End-user e2e + screenshots for the fullscreen Peers tab (#393; super-repo #560 regression). Serves
 * the real built `app.html` over the static harness with a stubbed `chrome.*` that answers
 * `getControlStatus` (node online), `pairingState`, and the `controlAuthed` proxy for the token-gated
 * `control.peerStatus` — the SAME dig-node wire contract the real extension drives.
 *
 * Proves the two halves of the #560 fix:
 *   1. HAPPY PATH — a reachable + PAIRED node renders the peer list (the view the user could not load).
 *   2. REGRESSION — a reachable but UNPAIRED node offers the pairing affordance, NOT a dead "couldn't
 *      load peers / try again" error (the token-gated `control.peerStatus` returns -32030 unpaired, so
 *      pairing — not retry — is the real precondition). Output → e2e/__screenshots__/.
 */

/** A forward-compatible peerStatus advertising per-peer detail + management (the node ships this later). */
const PEERS_PAIRED = {
  running: true,
  connected_peers: 2,
  management_supported: true,
  peers: [
    { peer_id: 'peerAlpha0001', addresses: ['[2001:db8::1]:8444'], connection_type: 'direct', direction: 'outbound', latency_ms: 42 },
    { peer_id: 'peerBravo0002', addresses: ['[2001:db8::2]:8444'], connection_type: 'relayed', direction: 'inbound', latency_ms: 118 },
  ],
  bans: [],
};

function stub(opts: { paired: boolean; peerStatus?: unknown }): string {
  return `
(() => {
  const PAIRED = ${opts.paired};
  const PEER_STATUS = ${JSON.stringify(opts.peerStatus ?? {})};
  const canned = (msg) => {
    const a = msg && msg.action;
    if (a === 'getLockState') return { lockState: 'unlocked' };
    if (a === 'getControlStatus') return { mode: 'manage', localNode: true, base: 'https://dig.local', controlEndpoint: 'https://dig.local/', readFallback: 'https://rpc.dig.net', status: {}, authRequired: false, controlMethods: [] };
    if (a === 'pairingState') return PAIRED ? { phase: 'paired' } : { phase: 'unpaired' };
    if (a === 'controlAuthed') {
      // The SW gate: a token-gated control.* call with no paired token answers -32030 (#281).
      if (!PAIRED) return { success: false, error: 'not paired', code: -32030 };
      if (msg.method === 'control.peerStatus') return PEER_STATUS;
      return { success: true };
    }
    return { success: true };
  };
  window.chrome = {
    runtime: {
      id: 'peers-tab-harness',
      sendMessage: (msg, cb) => { const r = canned(msg); if (typeof cb === 'function') { cb(r); return; } return Promise.resolve(r); },
      getURL: (p) => p,
      onMessage: { addListener() {}, removeListener() {} },
      openOptionsPage() {},
      getManifest: () => ({ version: '1.99.1' }),
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

async function open(page: Page, opts: { paired: boolean; peerStatus?: unknown }) {
  await page.addInitScript(stub(opts));
  await page.route('**/store.json', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ apps: [] }) }));
  await page.goto('/app.html#peers');
  await page.getByTestId('peers-panel').waitFor();
  await page.waitForTimeout(300);
  await settlePaint(page);
}

/** Let the `.dig-screen` mount transition composite before a screenshot (see updates-tab.spec.ts). */
async function settlePaint(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

const PHONE = { width: 372, height: 720 };
const TABLET = { width: 1200, height: 900 };

test('fullscreen Peers tab — a paired node renders the connected-peer list (desktop)', async ({ page }) => {
  await page.setViewportSize(TABLET);
  await open(page, { paired: true, peerStatus: PEERS_PAIRED });
  // The list — the view the user could not load — renders with both peers.
  await expect(page.getByTestId('peers-table')).toBeVisible();
  await expect(page.getByTestId('peer-row')).toHaveCount(2);
  await expect(page.getByTestId('peers-count')).toContainText('2');
  // IPv6-first address is shown (§5.2).
  await expect(page.getByTestId('peers-table')).toContainText('2001:db8::1');
  // Management is usable once the node advertises support.
  await expect(page.getByTestId('peers-connect-input')).toBeEnabled();
  // No error wall.
  await expect(page.getByTestId('peers-error')).toHaveCount(0);
  await page.screenshot({ path: 'e2e/__screenshots__/fullscreen-peers.png', fullPage: true });
});

test('Peers tab (#560) — an online-but-unpaired node offers pairing, not a dead "try again" error', async ({ page }) => {
  await page.setViewportSize(TABLET);
  await open(page, { paired: false });
  // The pairing CTA is the way forward.
  await expect(page.getByTestId('control-pairing-start')).toBeVisible();
  // The token-gated peer content + its dead retry error are NOT rendered while unpaired.
  await expect(page.getByTestId('peers-error')).toHaveCount(0);
  await expect(page.getByTestId('peers-status')).toHaveCount(0);
  await page.screenshot({ path: 'e2e/__screenshots__/peers-unpaired.png', fullPage: true });
});

test('Peers tab — mobile width layout (paired)', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await open(page, { paired: true, peerStatus: PEERS_PAIRED });
  await expect(page.getByTestId('peers-panel')).toBeVisible();
  await expect(page.getByTestId('peers-table')).toBeVisible();
  await page.screenshot({ path: 'e2e/__screenshots__/mobile-peers.png', fullPage: true });
});
