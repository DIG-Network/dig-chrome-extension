import { test, expect, type Page } from '@playwright/test';

/**
 * END-USER e2e for #90 — the multi-wallet switcher, driven against the REAL built popup bundle
 * (dist-web). A STATEFUL `chrome.runtime.sendMessage` stub models the SW-side wallet registry
 * (list / create / import / switch / rename / remove / lock / unlock) plus wallet-specific
 * derived reads (receive address + balances keyed on the active wallet), so switching genuinely
 * changes what the UI shows — exactly the contract the shipped SW implements. This exercises the
 * real RTK store + tag invalidation + the real switcher/onboarding/gate components; only the SW +
 * chain are stubbed.
 *
 * Run: `npm run build:web && npx playwright test e2e/wallet-switcher.spec.ts`.
 */

const PHRASE24 = Array(24).fill('abandon').join(' ');

/** Stateful chrome.* stub: an unlocked wallet registry + per-wallet derived reads. */
const STUB = `
(() => {
  let seq = 1;
  let wallets = [{ id: 'w1', label: 'Wallet 1', createdAt: 1 }];
  let activeId = 'w1';
  let lockState = 'unlocked';
  const unlocked = new Set(['w1']);
  const addr = (id) => 'xch1' + id + 'a'.repeat(52);
  const bal = (id) => (id === 'w1' ? 5000000000000 : 1230000000000);
  // previewAddress (#176): every wallet's cached preview is deterministic from its id here (the real
  // SW only populates it once a wallet has been active at index 0 — see e2e/sw for that proof); the
  // stub back-fills it up front so the redesigned list's per-row address preview renders for real.
  const meta = () => wallets.map((w) => ({ id: w.id, label: w.label, createdAt: w.createdAt, active: w.id === activeId, previewAddress: addr(w.id) }));
  const setActive = (id) => { activeId = id; };
  const add = (label) => { seq += 1; const id = 'w' + seq; wallets.push({ id, label: label || ('Wallet ' + seq), createdAt: Date.now() }); unlocked.add(id); setActive(id); lockState = 'unlocked'; return id; };
  const canned = (msg) => {
    const a = msg && msg.action;
    if (a === 'getLockState') return { lockState, activeWalletId: activeId };
    if (a === 'listWallets') return { wallets: meta(), activeWalletId: activeId };
    if (a === 'createWallet') { const id = add(msg.label); return { lockState: 'unlocked', mnemonic: '${PHRASE24}', activeWalletId: id }; }
    if (a === 'importWallet') { const id = add(msg.label); return { lockState: 'unlocked', activeWalletId: id }; }
    if (a === 'switchWallet') {
      if (unlocked.has(msg.walletId)) { setActive(msg.walletId); return { lockState: 'unlocked', activeWalletId: activeId }; }
      if (msg.password) { if (msg.password === 'password1') { unlocked.add(msg.walletId); setActive(msg.walletId); return { lockState: 'unlocked', activeWalletId: activeId }; } return { success: false, code: 'UNLOCK_FAILED' }; }
      return { success: false, code: 'NEEDS_UNLOCK' };
    }
    if (a === 'renameWallet') { wallets = wallets.map((w) => (w.id === msg.walletId ? { ...w, label: msg.label } : w)); return { success: true, wallets: meta(), activeWalletId: activeId }; }
    if (a === 'removeWallet') {
      if (wallets.length <= 1) return { success: false, code: 'LAST_WALLET' };
      const wasActive = msg.walletId === activeId;
      wallets = wallets.filter((w) => w.id !== msg.walletId);
      unlocked.delete(msg.walletId);
      if (wasActive) setActive(wallets[0].id);
      return { success: true, wallets: meta(), activeWalletId: activeId, lockState: 'unlocked' };
    }
    if (a === 'lockWallet') { lockState = 'locked'; unlocked.clear(); return { lockState: 'locked' }; }
    if (a === 'unlockWallet') { lockState = 'unlocked'; unlocked.add(activeId); return { lockState: 'unlocked', activeWalletId: activeId }; }
    if (a === 'getReceiveAddress') return { address: addr(activeId) };
    if (a === 'getCustodyBalances') return { balances: { xch: bal(activeId), cats: {} } };
    if (a === 'getActivity') return { events: [], cursorHeight: 0 };
    return { success: true };
  };
  const store = {};
  const changeListeners = new Set();
  const pick = (keys) => {
    if (keys == null) return { ...store };
    if (typeof keys === 'string') return store[keys] !== undefined ? { [keys]: store[keys] } : {};
    if (Array.isArray(keys)) { const o = {}; for (const k of keys) if (store[k] !== undefined) o[k] = store[k]; return o; }
    return { ...store };
  };
  window.chrome = {
    runtime: {
      id: 'switcher-harness',
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

async function openWallet(page: Page, file = 'popup.html') {
  await page.addInitScript(STUB);
  await page.goto(`/${file}#wallet`);
  await expect(page.getByTestId('custody-wallet')).toBeVisible();
}

async function openSwitcher(page: Page) {
  await page.getByTestId('wallet-switcher-toggle').click();
  await expect(page.getByTestId('wallet-switcher-sheet')).toBeVisible();
}

/** Add a second wallet by importing a recovery phrase, from the switcher's add flow. */
async function importSecondWallet(page: Page) {
  await openSwitcher(page);
  await page.getByTestId('wallet-add').click();
  await expect(page.getByTestId('wallet-add-flow')).toBeVisible();
  await page.getByTestId('onboarding-import').click();
  await page.getByTestId('import-phrase').fill(PHRASE24);
  await page.getByTestId('onboarding-password').fill('password1');
  await page.getByTestId('onboarding-password-confirm').fill('password1');
  await page.getByTestId('onboarding-submit').click();
  // The sheet closes on success and the active wallet becomes the imported one.
  await expect(page.getByTestId('wallet-switcher-sheet')).toBeHidden();
}

test.describe('#90 multi-wallet switcher', () => {
  test('import a 2nd wallet → switch → active address + balance change → rename → remove → lock/unlock', async ({ page }) => {
    await openWallet(page);

    // One wallet to start; its address is derived for the active wallet.
    await expect(page.getByTestId('wallet-switcher-active')).toHaveText('Wallet 1');
    const addr1 = await page.getByTestId('wallet-address').inputValue();
    expect(addr1).toContain('w1');

    // Import a second wallet → it becomes active; the derived address + balance change.
    await importSecondWallet(page);
    await expect(page.getByTestId('wallet-switcher-active')).toHaveText('Wallet 2');
    await expect(page.getByTestId('wallet-address')).not.toHaveValue(addr1);
    const addr2 = await page.getByTestId('wallet-address').inputValue();
    expect(addr2).toContain('w2');

    // Switch back to the first wallet (cached → instant) → the address returns to wallet 1's.
    await openSwitcher(page);
    await page.getByTestId('wallet-switch-w1').click();
    await expect(page.getByTestId('wallet-switcher-sheet')).toBeHidden();
    await expect(page.getByTestId('wallet-switcher-active')).toHaveText('Wallet 1');
    await expect(page.getByTestId('wallet-address')).toHaveValue(addr1);

    // Rename the second wallet.
    await openSwitcher(page);
    await page.getByTestId('wallet-rename-w2').click();
    await page.getByTestId('wallet-rename-input-w2').fill('Savings');
    await page.getByTestId('wallet-rename-save-w2').click();
    await expect(page.getByTestId('wallet-row-w2')).toContainText('Savings');

    // Remove the second wallet (two-step confirm) → it's gone; only wallet 1 remains.
    await page.getByTestId('wallet-remove-w2').click();
    await page.getByTestId('wallet-remove-yes-w2').click();
    await expect(page.getByTestId('wallet-switcher-sheet')).toBeHidden();
    await openSwitcher(page);
    await expect(page.getByTestId('wallet-row-w2')).toHaveCount(0);
    await expect(page.getByTestId('wallet-row-w1')).toBeVisible();

    // Lock from the manager → the gate falls back to the unlock screen.
    await page.getByTestId('wallet-lock').click();
    await expect(page.getByTestId('custody-unlock')).toBeVisible();

    // Unlock again → back to the wallet, active wallet 1.
    await page.getByTestId('unlock-password').fill('password1');
    await page.getByTestId('unlock-submit').click();
    await expect(page.getByTestId('custody-wallet')).toBeVisible();
    await expect(page.getByTestId('wallet-switcher-active')).toHaveText('Wallet 1');
  });

  test('#176 redesign: current-wallet card, per-row address previews, and arrow-key nav', async ({ page }) => {
    await openWallet(page);
    await importSecondWallet(page);
    await openSwitcher(page);

    // The prominent current-wallet card shows the active wallet's label + live address.
    await expect(page.getByTestId('wallet-switcher-current-label')).toHaveText('Wallet 2');
    await expect(page.getByTestId('wallet-switcher-current-address')).not.toBeEmpty();

    // Every row (including the active one) shows its cached address preview, never a blank/wrong one.
    await expect(page.getByTestId('wallet-address-preview-w1')).not.toBeEmpty();
    await expect(page.getByTestId('wallet-address-preview-w2')).not.toBeEmpty();

    // Keyboard: ArrowDown/ArrowUp roves focus between the switch buttons; Enter activates natively.
    await page.getByTestId('wallet-switch-w1').focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId('wallet-switch-w2')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('wallet-switcher-sheet')).toBeHidden();
    await expect(page.getByTestId('wallet-switcher-active')).toHaveText('Wallet 2');

    // Escape closes the sheet from anywhere in the list.
    await openSwitcher(page);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('wallet-switcher-sheet')).toBeHidden();
  });

  // Visual capture (§6.5) — the manager sheet at phone (popup) + tablet (fullscreen) widths.
  for (const [label, file, size] of [
    ['popup', 'popup.html', { width: 372, height: 640 }],
    ['fullscreen', 'app.html', { width: 1200, height: 860 }],
  ] as const) {
    test(`screenshot: wallet switcher manager (${label})`, async ({ page }) => {
      await page.setViewportSize(size);
      await openWallet(page, file);
      await importSecondWallet(page); // two wallets so the list is representative
      await openSwitcher(page);
      await page.waitForTimeout(200);
      await page.screenshot({ path: `e2e/__screenshots__/wallet-switcher-${label}.png` });
    });
  }
});
