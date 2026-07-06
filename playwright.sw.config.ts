import { defineConfig } from '@playwright/test';

/**
 * Playwright config for the browser SW-REGISTRATION harness (#68 — the GATE for the §6.4 service
 * worker migration). It loads the BUILT unpacked extension from `dist/` in real headless Chromium
 * and asserts the MV3 module service worker registers, its module graph (incl. the dig_client wasm)
 * instantiates, the message router answers, the offscreen key-custody vault can be created, and
 * chia:// interception reaches the SW. See e2e/sw/sw-registration.spec.ts.
 *
 * Separate from playwright.config.ts (the dist-web screenshot harness) because this one loads a
 * whole extension via a persistent context — no static webServer, and it must run serially (one
 * persistent context / SW at a time). Run: `npm run build && npm run test:sw`.
 */
export default defineConfig({
  testDir: './e2e/sw',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  timeout: 60_000,
  expect: { timeout: 20_000 },
});
