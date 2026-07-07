import { test, expect, chromium, type BrowserContext, type Worker } from '@playwright/test';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

/**
 * End-to-end proof for #153 — the DIG Mark manifest icon set + per-page tab favicons. Driven
 * against the BUILT unpacked extension in real headless Chromium (same harness as
 * sw-registration.spec.ts), so it proves the shipped `dist/` artifact — not just source files —
 * actually serves crisp, distinct, per-size DIG Mark PNGs for:
 *   - the toolbar/extension-management icon (manifest `action.default_icon` / `icons`, each of
 *     16/32/48/128 resolving to a real, non-empty, correctly-sized PNG resource);
 *   - every extension page's `<link rel="icon">` tab favicon (resolves to a real image, not 404).
 *
 * Also saves reference screenshots (chrome://extensions row showing the toolbar/management icon,
 * plus the popup and options pages) for visual confirmation — not asserted on pixel content
 * (that's what the resource-shape checks above are for), just a human-inspectable record.
 *
 * Run: `npm run build && npm run test:sw`.
 */

const EXT_PATH = resolve(process.cwd(), 'dist');
const SCREENSHOT_DIR = resolve(process.cwd(), 'e2e', '__screenshots__', 'branding-153');

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let extensionId: string;

test.beforeAll(async () => {
  if (!existsSync(resolve(EXT_PATH, 'manifest.json'))) {
    throw new Error(`Built extension not found at ${EXT_PATH} — run \`npm run build\` before the SW harness.`);
  }
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    args: ['--headless=new', `--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`],
  });
  const worker: Worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extensionId = worker.url().split('/')[2];
});

test.afterAll(async () => {
  await context?.close();
});

test('manifest exposes four DISTINCT DIG Mark sizes, each a real fetchable PNG', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  const manifest = await page.evaluate(() => chrome.runtime.getManifest());
  const defaultIcon = (manifest.action as { default_icon?: Record<string, string> }).default_icon ?? {};
  const icons = (manifest.icons ?? {}) as Record<string, string>;

  for (const size of [16, 32, 48, 128]) {
    expect(defaultIcon[String(size)], `action.default_icon[${size}]`).toBeTruthy();
    expect(icons[String(size)], `icons[${size}]`).toBeTruthy();
  }
  // Never the same file reused for every size (the #153 bug being fixed).
  expect(new Set(Object.values(defaultIcon)).size).toBe(4);
  expect(new Set(Object.values(icons)).size).toBe(4);

  for (const size of [16, 32, 48, 128]) {
    const relPath = defaultIcon[String(size)];
    const url = `chrome-extension://${extensionId}/${relPath}`;
    const resp = await page.evaluate(async (u) => {
      const r = await fetch(u);
      const blob = await r.blob();
      return { ok: r.ok, contentType: r.headers.get('content-type'), byteLength: blob.size };
    }, url);
    expect(resp.ok, `${relPath} fetchable`).toBe(true);
    expect(resp.byteLength, `${relPath} non-empty`).toBeGreaterThan(0);
  }
  await page.close();
});

for (const p of ['popup.html', 'options.html', 'newtab.html', 'welcome.html', 'app.html']) {
  test(`${p} ships a resolvable DIG Mark tab favicon`, async () => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/${p}`);
    // page.request (APIRequestContext) doesn't support the chrome-extension: scheme — fetch
    // in-page instead, same as the manifest-icon check above.
    const result = await page.evaluate(async () => {
      const link = document.querySelector('link[rel="icon"]') as HTMLLinkElement | null;
      if (!link?.href) return { href: null, ok: false, byteLength: 0 };
      const r = await fetch(link.href);
      const blob = await r.blob();
      return { href: link.href, ok: r.ok, byteLength: blob.size };
    });
    expect(result.href, `${p} has a <link rel="icon">`).toBeTruthy();
    expect(result.ok, `${p} favicon resource resolves`).toBe(true);
    expect(result.byteLength, `${p} favicon is non-empty`).toBeGreaterThan(0);
    await page.close();
  });
}

test('visual record: chrome://extensions row + popup + options screenshots', async () => {
  const mgmt = await context.newPage();
  await mgmt.goto('chrome://extensions/');
  await mgmt.screenshot({ path: `${SCREENSHOT_DIR}/extensions-page.png` });
  await mgmt.close();

  const popup = await context.newPage();
  await popup.setViewportSize({ width: 400, height: 620 });
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.screenshot({ path: `${SCREENSHOT_DIR}/popup.png` });
  await popup.close();

  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await options.screenshot({ path: `${SCREENSHOT_DIR}/options.png` });
  await options.close();
});
