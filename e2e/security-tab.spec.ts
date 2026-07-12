import { test, expect, type Page } from '@playwright/test';

/**
 * End-user e2e + screenshots for the fullscreen Security tab (#433, child of EPIC #431). Serves the
 * real built app.html over the static harness with a stubbed `chrome.*` that answers the dig-node
 * node-managed unlock-auth surface (SPEC §18.24) at the `chrome.runtime.sendMessage` seam:
 * `getControlStatus` (node online), `pairingState` (paired, so the panel shows), `getSignAuthority`
 * (the node IS the signer → the per-transaction prompt is live), and the `authRpc` methods
 * (`auth.status` / `auth.set_mode` / `auth.enroll_totp` / `auth.unlock`). Proves the tab renders,
 * the mode toggle re-verifies the current factor, and TOTP enrollment shows the QR + secret + verify.
 * Output → e2e/__screenshots__/.
 */

/** Mutable node auth state the stub advances as the UI drives it. */
const STATE = { mode: 'per_transaction', method: 'password', state: 'locked', sign_armed: false, has_wallet: true };

function stub(): string {
  return `
(() => {
  const STATE = ${JSON.stringify(STATE)};
  const canned = (msg) => {
    const a = msg && msg.action;
    if (a === 'getLockState') return { lockState: 'unlocked' };
    if (a === 'getControlStatus') return { mode: 'manage', localNode: true, base: 'https://dig.local', controlEndpoint: 'https://dig.local/', readFallback: 'https://rpc.dig.net', status: {}, authRequired: false, controlMethods: [] };
    if (a === 'pairingState') return { phase: 'paired' };
    if (a === 'getSignAuthority') return { nodeIsSigner: true };
    if (a === 'authRpc') {
      const m = msg.method, p = msg.params || {};
      if (m === 'auth.status') return { ...STATE };
      if (m === 'auth.set_mode') { STATE.mode = p.mode; STATE.state = p.mode === 'session_unlock_all' ? 'read_only' : STATE.state; return { ...STATE }; }
      if (m === 'auth.set_method') { STATE.method = p.method; return { ...STATE }; }
      if (m === 'auth.enroll_totp') { STATE.method = 'totp'; return { secret_base32: 'JBSWY3DPEHPK3PXP', otpauth_uri: 'otpauth://totp/DIG%20Node?secret=JBSWY3DPEHPK3PXP&issuer=DIG' }; }
      if (m === 'auth.unlock') { if ((p.totp_code && p.totp_code !== '654321')) return { success: false, code: -32030, message: 'unauthorized' }; STATE.state = 'read_only'; return { ...STATE }; }
      if (m === 'auth.sign_unlock') { if (p.totp_code && p.totp_code !== '654321') return { success: false, code: -32030, message: 'unauthorized' }; STATE.state = 'read_only'; STATE.sign_armed = true; return { ...STATE }; }
      if (m === 'auth.lock') { STATE.state = 'locked'; STATE.sign_armed = false; return { ...STATE }; }
      return { success: false, code: 'AUTH_BAD_METHOD', message: 'unknown' };
    }
    return { success: true };
  };
  const store = {};
  window.chrome = {
    runtime: {
      id: 'security-tab-harness',
      sendMessage: (msg, cb) => { const r = canned(msg); if (typeof cb === 'function') { cb(r); return; } return Promise.resolve(r); },
      getURL: (p) => p,
      onMessage: { addListener() {}, removeListener() {} },
      openOptionsPage() {},
      getManifest: () => ({ version: '1.97.0' }),
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

async function open(page: Page) {
  await page.addInitScript(stub());
  await page.route('**/store.json', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ apps: [] }) }));
  await page.goto('/app.html#security');
  await page.getByTestId('security-tab-panel').waitFor();
  await page.getByTestId('security-panel').waitFor();
  await page.waitForTimeout(300);
}

const PHONE = { width: 372, height: 720 };
const TABLET = { width: 1200, height: 900 };

test('fullscreen Security tab — renders the three management sections (desktop)', async ({ page }) => {
  await page.setViewportSize(TABLET);
  await open(page);
  await expect(page.getByTestId('security-session')).toBeVisible();
  await expect(page.getByTestId('security-mode')).toBeVisible();
  await expect(page.getByTestId('security-method')).toBeVisible();
  // Per-transaction is the secure default; passkey is a disabled "coming soon".
  await expect(page.getByTestId('security-mode-per-transaction-input')).toBeChecked();
  await expect(page.getByTestId('security-passkey-enroll')).toBeDisabled();
  await page.screenshot({ path: 'e2e/__screenshots__/fullscreen-security.png', fullPage: true });
});

test('Security tab — switching to session-unlock-all re-verifies the current factor', async ({ page }) => {
  await page.setViewportSize(TABLET);
  await open(page);
  await page.getByTestId('security-mode-session-all-input').click();
  // A confirmation prompt appears — the switch is NOT applied until the credential is confirmed.
  await expect(page.getByTestId('security-mode-confirm')).toBeVisible();
  await page.getByTestId('security-mode-cred-password').fill('correct horse');
  await page.screenshot({ path: 'e2e/__screenshots__/security-mode-confirm.png', fullPage: true });
  await page.getByTestId('security-mode-cred-submit').click();
  await expect(page.getByTestId('security-mode-session-all-input')).toBeChecked();
});

test('Security tab — TOTP enrollment shows the QR + secret + verify (desktop)', async ({ page }) => {
  await page.setViewportSize(TABLET);
  await open(page);
  await page.getByTestId('security-totp-enroll').click();
  await page.getByTestId('security-totp-enroll-cred-password').fill('correct horse');
  await page.getByTestId('security-totp-enroll-cred-submit').click();
  await expect(page.getByTestId('security-totp-qr')).toBeVisible();
  await expect(page.getByTestId('security-totp-secret')).toHaveText('JBSWY3DPEHPK3PXP');
  await page.screenshot({ path: 'e2e/__screenshots__/security-totp-enroll.png', fullPage: true });
  // Verify with the accepted code → the authenticator is confirmed active.
  await page.getByTestId('security-totp-verify-password').fill('correct horse');
  await page.getByTestId('security-totp-verify-totp').fill('654321');
  await page.getByTestId('security-totp-verify-submit').click();
  await expect(page.getByTestId('security-totp-verified')).toBeVisible();
});

test('Security tab — mobile width layout', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await open(page);
  await expect(page.getByTestId('security-session')).toBeVisible();
  await expect(page.getByTestId('security-method')).toBeVisible();
  await page.screenshot({ path: 'e2e/__screenshots__/mobile-security.png', fullPage: true });
});
