import { test, expect, chromium, type BrowserContext, type Worker, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

/**
 * LEG C — HOSTED-TIER live e2e for #228: a rootless `chia://` URN verifies against the CHAIN-
 * ANCHORED root with NO local dig-node reachable at all — the hosted rpc.dig.net + coinset.org path.
 * Unlike LEG B (`live-node-content-load.spec.ts`), this suite does NOT require a local dig-node and
 * does not self-skip in CI: forcing `server.host` to a dead port makes the §5.3 ladder fall straight
 * through dig.local/localhost to the hosted rpc.dig.net tier, which is exactly the scenario #228
 * fixes (rpc.dig.net doesn't serve `dig.getAnchoredRoot` — see #226's issue body — so the extension
 * must resolve the anchored root itself, directly from coinset.org, via the offscreen vault's
 * DataLayer store-coin driver wasm).
 *
 * Why this hits REAL rpc.dig.net + REAL api.coinset.org instead of mocking them: Playwright's
 * `context.route()` interception does NOT reach fetches made from inside the TRUE
 * `chrome.offscreen` document (a distinct CDP target type) — empirically confirmed while building
 * this test (a route registered for `**\/api.coinset.org/**` recorded ZERO hits while the SAME
 * request demonstrably succeeded against the live network). This matches the pre-existing,
 * independently-documented limitation in `cat-discovery.spec.ts` ("a LIVE coinset is non-
 * deterministic and the offscreen document's wasm chain fetch cannot be locally routed"). Given
 * that, this test hits the REAL, PUBLIC, READ-ONLY endpoints for the SAME known, permanently
 * chain-anchored dighub harness store LEG B already relies on (real content pushed via digstore CLI,
 * 2026-06-17) — no funds ever move; the store's lineage cannot change retroactively. This is the only
 * way in this harness to prove the REAL offscreen-vault coinset walk end-to-end (mirroring hub.dig.net's
 * `lib/lineage.ts`); the exhaustive fail-closed matrix (missing coin record, unparsable spend, melt,
 * depth-exceeded, transport errors) is covered deterministically in `src/offscreen/anchoredRoot.test.ts`
 * against the SAME store's real captured chain bytes (against a REAL wasm parser, not a hand-rolled fake).
 *
 * Run: `npm run build && npm run test:sw`.
 */

const EXT_PATH = resolve(process.cwd(), 'dist');
const STORE_ID = 'ab554db9c62e8dc2185914741e06539bacdcc3670762417a5f644b84fd382812';
const ANCHORED_ROOT = '9e26ff2500930604278dd013c986a3d3ace2565c69e13583e8575c70319bd98b';
const EXPECT_TEXT = 'dighub STORE pipeline harness';
const URN_ROOTLESS = `chia://urn:dig:chia:${STORE_ID}/index.html`;
const URN_ROOTED = `chia://urn:dig:chia:${STORE_ID}:${ANCHORED_ROOT}/index.html`;
// A non-alias loopback (matches live-node-content-load.spec.ts's proven-dead literal) — a GENUINE
// custom override that wins the §5.3 ladder entirely, so no dig.local/localhost probe can rescue it.
const DEAD_LOCAL_NODE = 'http://127.0.0.5:9';

type ProxyResult = { success: boolean; data?: string; contentType?: string; verified?: boolean; code?: string; message?: string; error?: string };

let context: BrowserContext;
let extensionId: string;
let worker: Worker;

async function extPage(): Promise<Page> {
  const p = await context.newPage();
  await p.goto(`chrome-extension://${extensionId}/dig-viewer.html?urn=chia://${'c'.repeat(64)}/x`);
  return p;
}
async function forceNodeDown(page: Page): Promise<void> {
  await page.evaluate(async (host) => { await chrome.storage.local.set({ 'server.host': host }); }, DEAD_LOCAL_NODE);
}
async function swProxy(page: Page, url: string): Promise<ProxyResult> {
  return page.evaluate((u) => new Promise<ProxyResult>((res) => chrome.runtime.sendMessage({ action: 'proxyRequest', url: u }, (r: ProxyResult) => res(r))), url);
}

test.beforeAll(async () => {
  if (!existsSync(resolve(EXT_PATH, 'manifest.json'))) throw new Error(`run \`npm run build\` first — no ${EXT_PATH}`);
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    args: ['--headless=new', `--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`],
  });
  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extensionId = worker.url().split('/')[2];
});
test.afterAll(async () => {
  await context?.close();
});

test('C.1 — HOSTED tier (no local node reachable): a rootless chia:// URN verifies against the coinset-resolved chain-anchored root (#228)', async () => {
  const cfg = await extPage();
  await forceNodeDown(cfg);

  const r = await swProxy(cfg, URN_ROOTLESS);
  console.log('hosted-tier rootless proxyRequest: success=%s verified=%s code=%s', r.success, r.verified, r.code || '');
  expect(r.success, `rootless read succeeds via the hosted rpc.dig.net tier (err=${r.error || r.message || ''})`).toBe(true);

  const decoded = Buffer.from(r.data!.split(',')[1], 'base64').toString('utf8');
  expect(decoded, 'content decrypts correctly through the hosted tier').toContain(EXPECT_TEXT);

  // THE #228 ASSERTION: before this fix, a rootless URN on the hosted tier (no local node) always
  // reported verified=false — rpc.dig.net doesn't serve dig.getAnchoredRoot (#226), and the hosted
  // tier had no other way to resolve the chain-anchored root. This now resolves it directly from
  // coinset.org via the offscreen vault's DataLayer store-coin driver wasm.
  expect(r.verified, 'rootless content verified against the coinset-resolved chain-anchored root').toBe(true);
  await cfg.close();
});

test('C.2 — HOSTED tier: a ROOTED URN (its own pinned generation) still verifies unaffected by #228', async () => {
  const cfg = await extPage();
  await forceNodeDown(cfg);

  const r = await swProxy(cfg, URN_ROOTED);
  console.log('hosted-tier rooted proxyRequest: success=%s verified=%s', r.success, r.verified);
  expect(r.success, 'rooted read succeeds via the hosted rpc.dig.net tier').toBe(true);
  expect(r.verified, 'rooted content verifies against its own pinned root (unaffected by #228)').toBe(true);
  await cfg.close();
});

test('C.3 — HOSTED tier: repeat rootless reads stay verified (the short-TTL anchored-root cache does not corrupt the result)', async () => {
  const cfg = await extPage();
  await forceNodeDown(cfg);

  const first = await swProxy(cfg, URN_ROOTLESS);
  const second = await swProxy(cfg, URN_ROOTLESS);
  console.log('repeat reads:', JSON.stringify({ firstVerified: first.verified, secondVerified: second.verified }));
  expect(first.success && first.verified, 'first read verified').toBe(true);
  expect(second.success && second.verified, 'second (cached-root) read still verified').toBe(true);
  await cfg.close();
});
