import { test, expect, chromium, type BrowserContext, type Worker, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

/**
 * END-USER e2e for first-run self-custody ONBOARDING, driven against the BUILT unpacked extension in
 * a real browser over the REAL background service worker + offscreen key-custody vault. The wallet
 * SWITCHER's add-wallet path is unit/dist-web tested (`e2e/wallet-switcher.spec.ts`), but the
 * first-run onboarding GATE on the real extension had no built-extension proof; this closes that
 * gap (#116). Onboarding lives in fullscreen (Fable), so it's driven on `app.html` at a wide
 * viewport (the compact popup shows a CTA card to it instead — asserted too).
 *
 * Proves, on a fresh profile with NO wallet:
 *   1. the popup (compact) shows the no-wallet CTA card that opens fullscreen onboarding;
 *   2. the fullscreen welcome offers all four entry paths (create / import / restore / watch);
 *   3. IMPORT lands unlocked end-to-end — paste the golden BIP39 phrase + a password → the gate
 *      proceeds to the real wallet body (`custody-wallet`);
 *   4. CREATE runs the REAL vault: welcome → set password → the recovery phrase is generated +
 *      revealed → the confirm gate rejects a wrong word (`confirm-error`) — a genuine end-to-end
 *      create through the verification gate. (The correct-word confirm isn't automatable: the phrase
 *      renders inside a CLOSED shadow root by design, so it can't be DOM-scraped.)
 *
 * Each onboarding case uses its OWN fresh persistent context so no earlier wallet leaks in.
 *
 * Run: `npm run build && npm run test:sw`.
 */

const EXT_PATH = resolve(process.cwd(), 'dist');
const GOLDEN = JSON.parse(readFileSync(resolve(process.cwd(), 'src/lib/keystore/derive.golden.json'), 'utf8')) as {
  mnemonic: string;
};
const PASSWORD = 'onboarding-e2e-not-a-real-secret';

test.describe.configure({ mode: 'serial' });

/** Launch a fresh (no-wallet) unpacked-extension context; returns the context + its extension id. */
async function freshExtension(): Promise<{ context: BrowserContext; extensionId: string }> {
  if (!existsSync(resolve(EXT_PATH, 'manifest.json'))) {
    throw new Error(`Built extension not found at ${EXT_PATH} — run \`npm run build\` before the e2e.`);
  }
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    args: ['--headless=new', `--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`],
  });
  const worker: Worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const extensionId = worker.url().split('/')[2];
  return { context, extensionId };
}

/** Open fullscreen onboarding: app.html at a wide viewport → CustodyGate activates the flow. */
async function openFullscreenOnboarding(context: BrowserContext, extensionId: string): Promise<Page> {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1200, height: 860 });
  await page.goto(`chrome-extension://${extensionId}/app.html#wallet`);
  await page.getByTestId('custody-onboarding').waitFor();
  return page;
}

test('the compact popup shows the no-wallet CTA that opens fullscreen onboarding', async () => {
  const { context, extensionId } = await freshExtension();
  try {
    const page = await context.newPage();
    await page.setViewportSize({ width: 372, height: 640 });
    await page.goto(`chrome-extension://${extensionId}/popup.html#wallet`);
    await expect(page.getByTestId('custody-nowallet')).toBeVisible();
    await expect(page.getByTestId('nowallet-setup')).toBeVisible();
    await page.waitForTimeout(120);
    await page.screenshot({ path: 'e2e/__screenshots__/onboarding-nowallet-popup.png' });
  } finally {
    await context.close();
  }
});

test('the fullscreen welcome offers create / import / restore / watch', async () => {
  const { context, extensionId } = await freshExtension();
  try {
    const page = await openFullscreenOnboarding(context, extensionId);
    await expect(page.getByTestId('onboarding-welcome')).toBeVisible();
    await expect(page.getByTestId('onboarding-create')).toBeVisible();
    await expect(page.getByTestId('onboarding-import')).toBeVisible();
    await expect(page.getByTestId('onboarding-restore')).toBeVisible();
    await expect(page.getByTestId('onboarding-watch')).toBeVisible();
    await page.waitForTimeout(120);
    await page.screenshot({ path: 'e2e/__screenshots__/onboarding-welcome-fullscreen.png' });
  } finally {
    await context.close();
  }
});

test('IMPORT the golden phrase → the gate proceeds to the real wallet (unlocked)', async () => {
  const { context, extensionId } = await freshExtension();
  try {
    const page = await openFullscreenOnboarding(context, extensionId);
    await page.getByTestId('onboarding-import').click();
    await page.getByTestId('import-phrase').fill(GOLDEN.mnemonic);
    await page.getByTestId('onboarding-password').fill(PASSWORD);
    await page.getByTestId('onboarding-password-confirm').fill(PASSWORD);
    await page.getByTestId('onboarding-submit').click();

    // onDone → the gate renders the real wallet body.
    await expect(page.getByTestId('custody-wallet')).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(120);
    await page.screenshot({ path: 'e2e/__screenshots__/onboarding-imported-wallet.png' });
  } finally {
    await context.close();
  }
});

test('CREATE runs the real vault: password → recovery reveal → confirm gate rejects a wrong word', async () => {
  const { context, extensionId } = await freshExtension();
  try {
    const page = await openFullscreenOnboarding(context, extensionId);
    await page.getByTestId('onboarding-create').click();
    await page.getByTestId('onboarding-password').fill(PASSWORD);
    await page.getByTestId('onboarding-password-confirm').fill(PASSWORD);
    await page.getByTestId('onboarding-submit').click();

    // The real vault created a wallet + returned a recovery phrase → the reveal step.
    await expect(page.getByTestId('recovery-reveal')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('recovery-reveal-btn').click();
    // The phrase renders behind a closed shadow root (un-scrapable) — the copy action appears.
    await expect(page.getByTestId('recovery-copy')).toBeVisible();
    await page.waitForTimeout(120);
    await page.screenshot({ path: 'e2e/__screenshots__/onboarding-recovery-reveal.png' });

    await page.getByTestId('reveal-continue').click();
    await expect(page.getByTestId('onboarding-confirm-form')).toBeVisible();

    // The confirm gate is real: a wrong word is rejected (never proceeds to the wallet).
    await page.getByTestId('confirm-word').fill('definitely-not-the-word');
    await page.getByTestId('confirm-submit').click();
    await expect(page.getByTestId('confirm-error')).toBeVisible();
    await expect(page.getByTestId('custody-wallet')).toHaveCount(0);
  } finally {
    await context.close();
  }
});
