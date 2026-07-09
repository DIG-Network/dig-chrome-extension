import { test, expect, type Page } from '@playwright/test';

/**
 * END-USER e2e for #88 — the address book / contacts, driven against the REAL built popup bundle
 * (dist-web). A FUNCTIONAL `chrome.storage.local` stub (backed by an in-page object that fires
 * `storage.onChanged` on write) lets the real `useStorageValue` seam persist + live-sync contacts,
 * exactly as in the shipped extension; the wallet's SW reads (lock state, balances, prepare/confirm
 * send) are answered by a canned `chrome.runtime.sendMessage`. This exercises the real RTK store +
 * the real contacts module/hook/components — only the SW + chain are stubbed.
 *
 * Also covers #207 — the recipient picker is now the XL Android-style contacts modal
 * (`contacts-xl-modal`): sticky A–Z sections, a search box, and a fast-scroll index, portaled to
 * `document.body` (#200). `pick-contact-<id>` / `pick-recent-<address>` test ids are unchanged from
 * the old inline picker, so most of the existing flows below needed no changes beyond the modal's
 * own container id.
 *
 * Run: `npm run build:web && npx playwright test e2e/contacts.spec.ts`.
 */

// Two valid-format xch1 addresses (lowercased, as the address book stores them). The SW send path
// is stubbed, so these never hit the offscreen bech32m decode.
const ALICE_ADDR = 'xch1qgp8xdq8lrsrljezregl9xk8ymw4x0h2z9m0j8zq0k7q9m8x0hqsm3g4tl';
const BOB_ADDR = 'xch1v9p8xdq8lrsrljezregl9xk8ymw4x0h2z9m0j8zq0k7q9m8x0hqsm3z2ab';

/** chrome.* stub: an unlocked wallet + a functional storage.local that fires onChanged on set. */
const STUB = `
(() => {
  const canned = (msg) => {
    const a = msg && msg.action;
    if (a === 'getLockState') return { lockState: 'unlocked' };
    if (a === 'getCustodyBalances') return { balances: { xch: 5000000000000, cats: {} } };
    if (a === 'getReceiveAddress') return { address: 'xch1qqqqdigcontactsdemoaddressqqqqqqqqqqqqqqqqqqqqqqqqqqqqzzzz' };
    if (a === 'getActivity') return { events: [], cursorHeight: 0 };
    if (a === 'prepareSend') return { pendingId: 'p1', summary: { asset: 'XCH', sent: '250000000000', change: '4749000000000', fee: '0', recipientPuzzleHashHex: 'ab', coinCount: 1 } };
    if (a === 'confirmSend') return { spentCoinId: 'coin1' };
    if (a === 'sendStatus') return { confirmed: true };
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
      id: 'contacts-harness',
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

/** From the wallet Home, open the Address book manager and add one contact. */
async function addContact(page: Page, label: string, address: string) {
  await page.getByTestId('action-contacts').click();
  await expect(page.getByTestId('contacts-manager')).toBeVisible();
  await page.getByTestId('contact-add-label').fill(label);
  await page.getByTestId('contact-add-address').fill(address);
  await page.getByTestId('contact-add-submit').click();
  await expect(page.getByTestId('contacts-list').getByText(label)).toBeVisible();
}

/** From the wallet Home, open the manager ONCE and add several contacts in the same visit (the
 * manager stays open between adds — `addContact` re-opens it from Home each time, which only works
 * for a single contact per Home visit). */
async function addContacts(page: Page, entries: Array<[label: string, address: string]>) {
  await page.getByTestId('action-contacts').click();
  await expect(page.getByTestId('contacts-manager')).toBeVisible();
  for (const [label, address] of entries) {
    await page.getByTestId('contact-add-label').fill(label);
    await page.getByTestId('contact-add-address').fill(address);
    await page.getByTestId('contact-add-submit').click();
    await expect(page.getByTestId('contacts-list').getByText(label)).toBeVisible();
  }
}

test.describe('#88 address book / contacts', () => {
  test('add a contact, pick it in Send → address + label populate', async ({ page }) => {
    await openWallet(page);
    await addContact(page, 'Alice', ALICE_ADDR);

    // Back to Home, open Send.
    await page.getByTestId('contacts-close').click();
    await page.getByTestId('action-send').click();
    await expect(page.getByTestId('custody-send')).toBeVisible();

    // Open the picker and choose the saved contact.
    await page.getByTestId('contact-picker-toggle').click();
    await page.locator('[data-testid^="pick-contact-"]').first().click();

    // The recipient input is filled with the (normalized) address, and the label chip shows.
    await expect(page.getByTestId('send-recipient')).toHaveValue(ALICE_ADDR);
    await expect(page.getByTestId('send-recipient-contact')).toContainText('Alice');

    // Review prefers the saved label over the raw address.
    await page.getByTestId('send-amount').fill('0.25');
    await page.getByTestId('send-review').click();
    await expect(page.getByTestId('review-recipient-label')).toHaveText('Alice');
  });

  test('add-on-send: save a new recipient inline from the review step', async ({ page }) => {
    await openWallet(page);
    await page.getByTestId('action-send').click();

    await page.getByTestId('send-recipient').fill(BOB_ADDR);
    await page.getByTestId('send-amount').fill('0.25');
    await page.getByTestId('send-review').click();

    // The recipient is unknown → the inline "save this recipient" is offered.
    await page.getByTestId('save-contact-open').click();
    await page.getByTestId('save-contact-label').fill('Bob');
    await page.getByTestId('save-contact-save').click();
    await expect(page.getByTestId('save-contact-saved')).toBeVisible();

    // It is now a saved contact: the picker (after going back) offers Bob by label.
    await page.getByTestId('send-back').click();
    await page.getByTestId('contact-picker-toggle').click();
    await expect(page.getByTestId('contacts-xl-modal').getByText('Bob')).toBeVisible();
  });

  test('manager edit + delete', async ({ page }) => {
    await openWallet(page);
    await addContact(page, 'Alice', ALICE_ADDR);

    const row = page.getByTestId('contacts-list').getByText('Alice');
    const testId = await row.getAttribute('data-testid');
    const id = testId!.replace('contact-label-', '');

    // Edit → rename.
    await page.getByTestId(`contact-edit-btn-${id}`).click();
    await page.getByTestId(`contact-edit-${id}-label`).fill('Alice B');
    await page.getByTestId(`contact-edit-${id}-submit`).click();
    await expect(page.getByTestId('contacts-list').getByText('Alice B')).toBeVisible();

    // Delete (two-step confirm).
    await page.getByTestId(`contact-delete-btn-${id}`).click();
    await page.getByTestId(`contact-delete-confirm-${id}`).click();
    await expect(page.getByTestId('contacts-empty')).toBeVisible();
  });

  // Visual capture (§6.5) — the manager + the Send picker at phone (popup) + tablet (fullscreen).
  for (const [label, file, size] of [
    ['popup', 'popup.html', { width: 372, height: 640 }],
    ['fullscreen', 'app.html', { width: 1200, height: 860 }],
  ] as const) {
    test(`screenshot: address book manager (${label})`, async ({ page }) => {
      await page.setViewportSize(size);
      await openWallet(page, file);
      await addContact(page, 'Alice', ALICE_ADDR);
      await page.waitForTimeout(200);
      await page.screenshot({ path: `e2e/__screenshots__/contacts-manager-${label}.png` });
    });

    test(`screenshot: Send with contact picker + label (${label})`, async ({ page }) => {
      await page.setViewportSize(size);
      await openWallet(page, file);
      await addContact(page, 'Alice', ALICE_ADDR);
      await page.getByTestId('contacts-close').click();
      await page.getByTestId('action-send').click();
      await page.getByTestId('contact-picker-toggle').click();
      await expect(page.getByTestId('contacts-xl-modal')).toBeVisible();
      await page.waitForTimeout(200);
      await page.screenshot({ path: `e2e/__screenshots__/contacts-send-picker-${label}.png` });
    });
  }
});

test.describe('#207 XL Android-style contacts modal', () => {
  test('open the picker, search narrows the list, and selecting a result fills the recipient', async ({ page }) => {
    await openWallet(page, 'app.html');
    await addContacts(page, [
      ['Alice', ALICE_ADDR],
      ['Bob', BOB_ADDR],
    ]);
    await page.getByTestId('contacts-close').click();
    await page.getByTestId('action-send').click();

    await page.getByTestId('contact-picker-toggle').click();
    await expect(page.getByTestId('contacts-xl-modal')).toBeVisible();
    // Both are alphabetized under their own letter section.
    await expect(page.getByTestId('contacts-xl-section-A')).toBeVisible();
    await expect(page.getByTestId('contacts-xl-section-B')).toBeVisible();

    await page.getByTestId('contacts-xl-search').fill('ali');
    await expect(page.locator('[data-testid^="pick-contact-"]')).toHaveCount(1);
    await page.locator('[data-testid^="pick-contact-"]').first().click();

    await expect(page.getByTestId('contacts-xl-modal')).toHaveCount(0);
    await expect(page.getByTestId('send-recipient')).toHaveValue(ALICE_ADDR);
  });

  // Visual capture (§6.5) — the XL modal itself at phone (popup, near-full-viewport) + tablet
  // (fullscreen, true XL) widths.
  for (const [label, file, size] of [
    ['popup', 'popup.html', { width: 372, height: 640 }],
    ['fullscreen', 'app.html', { width: 1200, height: 860 }],
  ] as const) {
    test(`screenshot: XL contacts modal (${label})`, async ({ page }) => {
      await page.setViewportSize(size);
      await openWallet(page, file);
      await addContacts(page, [
        ['Alice', ALICE_ADDR],
        ['Bob', BOB_ADDR],
      ]);
      await page.getByTestId('contacts-close').click();
      await page.getByTestId('action-send').click();
      await page.getByTestId('contact-picker-toggle').click();
      await expect(page.getByTestId('contacts-xl-modal')).toBeVisible();
      await page.waitForTimeout(200);
      await page.screenshot({ path: `e2e/__screenshots__/contacts-xl-modal-${label}.png` });
    });
  }
});
