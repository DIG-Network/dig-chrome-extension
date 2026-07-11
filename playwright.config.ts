import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the mobile-OS SCREENSHOT harness (#65). It serves the built `dist-web`
 * (the real popup.html / app.html bundles) over a static server and drives them with a stubbed
 * `chrome.*` (canned unlocked wallet + node status), so the screenshots show the true rendered
 * mobile-OS UI at phone + tablet widths. Run: `npm run build:web && npm run screenshots`.
 * Not part of the CI test/coverage gate — it's a local visual-verification tool.
 */
export default defineConfig({
  testDir: './e2e',
  // The dist-web specs: the screenshot harness + the #86 price-feed end-user e2e (both drive the
  // real popup bundle over the static server with a stubbed chrome.*). The SW-registration harness
  // (e2e/sw/) has its own config (playwright.sw.config.ts) — it loads the built unpacked extension.
  testMatch: [
    '**/screenshots.spec.ts',
    '**/prices.spec.ts',
    '**/contacts.spec.ts',
    '**/fee-estimate.spec.ts',
    '**/wallet-switcher.spec.ts',
    '**/home-balance.spec.ts',
    '**/wallet-balance-source.spec.ts',
    '**/home-flush-urn.spec.ts',
    '**/fullscreen-ui-batch.spec.ts',
    '**/loader-toolbar-shots.spec.ts',
    '**/did-create-errors.spec.ts',
    '**/send-receive-trio.spec.ts',
    '**/qr-scanner-camera.spec.ts',
    '**/settings-prefs.spec.ts',
    '**/accounts-keys.spec.ts',
  ],
  fullyParallel: true,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    headless: true,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'python -m http.server 4173 --directory dist-web',
    url: 'http://127.0.0.1:4173/popup.html',
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
