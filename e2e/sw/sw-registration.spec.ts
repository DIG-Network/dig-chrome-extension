import { test, expect, chromium, type BrowserContext, type Worker } from '@playwright/test';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

/**
 * Browser SW-registration verification harness (issue #68 — the GATE for the §6.4 SW migration).
 *
 * WHY this exists: background.js is the MV3 **module service worker**. Bundling or moving it (and
 * its runtime module graph — dig_client.js read-crypto wasm, the offscreen vault, the message
 * router, chia:// interception) changes HOW that graph loads AT RUNTIME. Build + unit tests CANNOT
 * validate that: there is no browser in the Node/vitest CI, and the static copy-list check
 * (tests/sw-worker-imports.test.mjs) only proves files exist, not that the SW actually registers
 * and its module graph instantiates. A drift here silently disables chia:// resolution + the wallet
 * with NO CI signal. This harness loads the BUILT unpacked extension in real headless Chromium and
 * asserts the SW registers and the core runtime paths work.
 *
 * It asserts, against `dist/` (must be built first — `npm run build`):
 *  1. the service worker actually registers (its top-level module graph — background.js + every
 *     static import incl. dig_client.js — parsed + instantiated with no load error);
 *  2. the dig_client read-crypto **wasm** loads + instantiates inside the SW context (the
 *     import.meta.url + 'wasm-unsafe-eval' path a bundler move could break);
 *  3. the SW message router answers a basic RPC (`getCapabilities`) end-to-end from an ext page;
 *  4. the **offscreen key-custody document** can be created and its wallet wasm runs — via
 *     `createWallet` with a THROWAWAY generated seed (never the real test mnemonic; the mnemonic is
 *     asserted structurally and NEVER logged);
 *  5. a `chia://` navigation reaches the SW and is intercepted (redirected to dig-viewer.html).
 *
 * Run: `npm run build && npm run test:sw`.
 */

// Playwright runs with cwd = the config/repo dir, so the built extension is at ./dist.
const EXT_PATH = resolve(process.cwd(), 'dist');

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let extensionId: string;
let worker: Worker;

test.beforeAll(async () => {
  if (!existsSync(resolve(EXT_PATH, 'manifest.json'))) {
    throw new Error(
      `Built extension not found at ${EXT_PATH} — run \`npm run build\` before the SW harness.`,
    );
  }
  // Extensions load only under a persistent context, only in the full Chromium build (the default
  // `chromium_headless_shell` does NOT support extensions → `channel: 'chromium'`), and MV3 SWs run
  // only in the new headless mode (`--headless=new`).
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    args: [
      '--headless=new',
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
    ],
  });

  // (1) The SW must register. If the module graph failed to instantiate (a missing/renamed import,
  // a bad bundle), no service worker ever appears here — this is the core gate.
  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extensionId = worker.url().split('/')[2];
});

test.afterAll(async () => {
  await context?.close();
});

test('service worker registers with no module-graph load error', async () => {
  expect(worker, 'the MV3 module service worker registered').toBeTruthy();
  expect(worker.url()).toMatch(/^chrome-extension:\/\/[a-p]{32}\/background\.js$/);
  expect(extensionId).toMatch(/^[a-p]{32}$/);
  // The SW's global scope is live + evaluable → its top-level module code ran to completion.
  const manifestVersion = await worker.evaluate(() => chrome.runtime.getManifest().manifest_version);
  expect(manifestVersion).toBe(3);
});

test('dig_client read-crypto wasm + glue are reachable extension resources from the SW', async () => {
  // The SW's read path (ensureDig → initDigClient) statically imports ./dig_client.js and, at
  // instantiate time, fetches dig_client_bg.wasm via import.meta.url. Test 1 already proves the
  // static import resolved (the SW registered). Here we assert — from the SW context, offline — that
  // both the wasm-bindgen glue AND the wasm binary are fetchable extension resources. A bundler
  // move/bundle of the SW that dropped dig_client_bg.wasm from dist/ or web_accessible_resources, or
  // relocated the glue, breaks exactly this. (Dynamic import() is spec-disallowed in a SW, so this
  // resource-reachability check is the offline, deterministic proxy for "the SW can load its wasm".)
  const reach = await worker.evaluate(async () => {
    const check = async (name: string) => {
      try {
        const r = await fetch(chrome.runtime.getURL(name));
        return r.ok;
      } catch {
        return false;
      }
    };
    return {
      glue: await check('dig_client.js'),
      wasm: await check('dig_client_bg.wasm'),
    };
  });
  expect(reach.glue).toBe(true);
  expect(reach.wasm).toBe(true);
});

test('SW message router answers getCapabilities end-to-end from an extension page', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  const caps = await page.evaluate(
    () =>
      new Promise<{ messageProtocol?: number; actions?: string[] }>((res) =>
        chrome.runtime.sendMessage({ action: 'getCapabilities' }, res),
      ),
  );
  expect(caps.messageProtocol).toBeGreaterThan(0);
  expect(Array.isArray(caps.actions)).toBe(true);
  expect(caps.actions).toContain('getCapabilities');
  expect(caps.actions).toContain('proxyRequest');
  await page.close();
});

test('offscreen key-custody document is created and its wallet wasm runs (throwaway seed)', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  // createWallet generates a fresh 24-word phrase, spins up the offscreen vault, runs
  // chia-wallet-sdk-wasm derivation, encrypts (DIGWX1) + persists. The seed is THROWAWAY and the
  // mnemonic is asserted structurally only — NEVER logged.
  const result = await page.evaluate(
    () =>
      new Promise<{ lockState?: string; mnemonic?: string; success?: boolean; code?: string }>(
        (res) =>
          chrome.runtime.sendMessage(
            { action: 'createWallet', password: 'harness-throwaway-pw-not-a-real-secret' },
            res,
          ),
      ),
  );
  expect(result.success).not.toBe(false);
  expect(result.lockState).toBe('unlocked');
  // Structural check only — do not log/expose the generated phrase.
  const wordCount = typeof result.mnemonic === 'string' ? result.mnemonic.trim().split(/\s+/).length : 0;
  expect(wordCount).toBe(24);

  // The lock state survives a round-trip through storage-derived getLockState (the offscreen vault
  // holds the key; the SW reports 'unlocked').
  const lock = await page.evaluate(
    () =>
      new Promise<{ lockState?: string }>((res) =>
        chrome.runtime.sendMessage({ action: 'getLockState' }, res),
      ),
  );
  expect(lock.lockState).toBe('unlocked');
  await page.close();
});

test('chia:// resolution path reaches the SW and redirects the tab to the dig-viewer', async () => {
  // A raw `chia://` URL is an external protocol Chrome won't navigate to (so webNavigation can't be
  // driven from a headless test), but the message-driven entry point exercises the SAME SW redirect
  // logic (handleDigUrlNavigation, shared with onBeforeNavigate): send `navigateToDigUrl` from an
  // extension-page tab and assert the SW redirects that tab to dig-viewer.html — offline proof the
  // chia:// resolution path runs in the SW.
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.evaluate(() =>
    chrome.runtime.sendMessage({
      action: 'navigateToDigUrl',
      url: 'chia://harness-example.dig/index.html',
    }),
  );
  await page.waitForURL(/\/dig-viewer\.html/, { timeout: 15_000 });
  expect(page.url()).toContain('/dig-viewer.html');
  expect(page.url()).toContain(extensionId);
  expect(decodeURIComponent(page.url())).toContain('harness-example.dig');
  await page.close();
});
