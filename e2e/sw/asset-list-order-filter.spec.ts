import { test, expect, chromium, type BrowserContext, type Worker, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

/**
 * END-USER e2e for #167 — order the Assets/CAT list by value (highest first) + a live filter with
 * autocomplete, driven against the BUILT unpacked extension in a real browser through the real
 * self-custody wallet + popup UI.
 *
 * Determinism note (mirrors cat-discovery.spec.ts): a held multi-CAT balance is supplied via the
 * SW's cached-first path (`walletCache.balances`, chain pointed at a dead endpoint so the live scan
 * times out and the seeded snapshot is served); the CAT metadata registry (`api.dexie.space/v1`) and
 * the two price sources (CoinGecko + `api.dexie.space/v2`) are mocked via Playwright routing so the
 * value-based ordering is fully reproducible.
 *
 * Holdings: XCH (hero, always first) + $DIG (10, $5 — ALWAYS pinned second per #202, regardless of
 * value) + AAA (5, $50 — highest of the rest) + BBB (2, $2) + an unregistered CAT (a huge raw amount
 * but genuinely unpriced — must still sort LAST). Expected order beneath XCH: $DIG, AAA, BBB,
 * unregistered.
 *
 * #204 additionally pins XCH + $DIG in a fixed header block ABOVE the filter input, excluded from
 * the filter predicate entirely — asserted below (both stay visible under any filter query, and
 * the DOM order is pinned-block → filter input → filterable CATs).
 *
 * Run: `npm run build && npm run test:sw`.
 */

const EXT_PATH = resolve(process.cwd(), 'dist');
const GOLDEN = JSON.parse(readFileSync(resolve(process.cwd(), 'src/lib/keystore/derive.golden.json'), 'utf8')) as { mnemonic: string };
const PASSWORD = 'e2e-167-not-a-real-secret';
const DIG_ASSET_ID = 'a406d3a9de984d03c9591c10d917593b434d5263cabe2b42f6b367df16832f81';

const CAT_A = 'a1'.repeat(32); // registry: "AAA" / "Alpha Token" — highest USD value
const CAT_B = 'b2'.repeat(32); // registry: "BBB" / "Beta Token" — mid USD value
const CAT_U = 'c3'.repeat(32); // NOT in the registry → generic "CAT" fallback, no price, huge amount

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let extensionId: string;
let worker: Worker;
let anchor: Page;

function swSend<T>(page: Page, message: Record<string, unknown>): Promise<T> {
  return page.evaluate((msg) => new Promise<T>((res) => chrome.runtime.sendMessage(msg, res as (r: unknown) => void)), message);
}

/** Open the popup on the Wallet tab, unlocking via the UI if it lands on the unlock screen. */
async function openWallet(): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html#wallet`);
  await page.getByTestId('custody-gate').waitFor({ timeout: 20_000 });
  if (await page.getByTestId('custody-unlock').isVisible().catch(() => false)) {
    await page.getByTestId('unlock-password').fill(PASSWORD);
    await page.getByTestId('unlock-submit').click();
  }
  await page.getByTestId('custody-wallet').waitFor({ timeout: 20_000 });
  return page;
}

function json(body: unknown) {
  return { status: 200, contentType: 'application/json', body: JSON.stringify(body) };
}

test.beforeAll(async () => {
  if (!existsSync(resolve(EXT_PATH, 'manifest.json'))) {
    throw new Error(`Built extension not found at ${EXT_PATH} — run \`npm run build\` before the e2e.`);
  }
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    args: ['--headless=new', `--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`],
  });
  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extensionId = worker.url().split('/')[2];

  // CAT metadata registry: AAA + BBB resolve to real names/tickers; CAT_U is deliberately absent.
  await context.route('**/api.dexie.space/v1/swap/tokens*', (route) =>
    route.fulfill(
      json({
        success: true,
        tokens: [
          { id: CAT_A, name: 'Alpha Token', code: 'AAA', denom: 1000 },
          { id: CAT_B, name: 'Beta Token', code: 'BBB', denom: 1000 },
        ],
      }),
    ),
  );
  // XCH = $10; AAA = 1 XCH each → 5 × $10 = $50 (highest); BBB = 0.1 XCH each → 2 × $1 = $2;
  // $DIG = 0.05 XCH each → 10 × $0.50 = $5. CAT_U has no ticker here → stays unpriced.
  await context.route('**/api.coingecko.com/**', (route) => route.fulfill(json({ chia: { usd: 10, usd_24h_change: null } })));
  await context.route('**/api.dexie.space/v2/prices/tickers*', (route) =>
    route.fulfill(
      json({
        tickers: [
          { base_id: CAT_A, target_id: 'xch', last_price: '1' },
          { base_id: CAT_B, target_id: 'xch', last_price: '0.1' },
          { base_id: DIG_ASSET_ID, target_id: 'xch', last_price: '0.05' },
        ],
      }),
    ),
  );

  anchor = await context.newPage();
  await anchor.goto(`chrome-extension://${extensionId}/popup.html`);
  const imported = await swSend<{ lockState?: string }>(anchor, { action: 'importWallet', mnemonic: GOLDEN.mnemonic, password: PASSWORD });
  expect(imported.lockState).toBe('unlocked');

  await anchor.evaluate(
    ({ digId, catA, catB, catU }) =>
      chrome.storage.local.set({
        'wallet.settings': { chainRpcUrl: 'http://127.0.0.1:1', chainPrivacyAck: true },
        'walletCache.balances': {
          balances: { xch: 2_000_000_000_000, cats: { [digId]: 10_000, [catA]: 5000, [catB]: 2000, [catU]: 999_999_000 } },
          at: Date.now(),
        },
      }),
    { digId: DIG_ASSET_ID, catA: CAT_A, catB: CAT_B, catU: CAT_U },
  );
});

test.afterAll(async () => {
  await context?.close();
});

test('the Assets list sorts: XCH first, $DIG ALWAYS second, then AAA ($50) > BBB ($2) > the unpriced CAT last', async () => {
  const page = await openWallet();
  await expect(page.getByTestId(`asset-cat-${CAT_A}`)).toBeVisible({ timeout: 25_000 });

  const testids = await page.getByTestId('custody-assets').locator('.dig-asset').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
  expect(testids).toEqual(['asset-xch', 'asset-dig', `asset-cat-${CAT_A}`, `asset-cat-${CAT_B}`, `asset-cat-${CAT_U}`]);
  await page.close();
});

test('typing in the filter narrows the list to matching tickers/names, leaving XCH AND $DIG visible (#204)', async () => {
  const page = await openWallet();
  await page.getByTestId(`asset-cat-${CAT_A}`).waitFor({ timeout: 25_000 });

  await page.getByTestId('asset-filter-input').fill('alpha');
  await expect(page.getByTestId('asset-xch')).toBeVisible();
  await expect(page.getByTestId('asset-dig')).toBeVisible(); // pinned — never hidden by the filter (#204)
  await expect(page.getByTestId(`asset-cat-${CAT_A}`)).toBeVisible();
  await expect(page.getByTestId(`asset-cat-${CAT_B}`)).toHaveCount(0);
  await page.close();
});

test('#204: XCH + $DIG render ABOVE the filter input, with the filterable CATs below it', async () => {
  const page = await openWallet();
  await page.getByTestId(`asset-cat-${CAT_A}`).waitFor({ timeout: 25_000 });

  const testids = await page.getByTestId('custody-assets').locator(':scope > *').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
  expect(testids).toEqual(['asset-xch', 'asset-dig', 'asset-filter', `asset-cat-${CAT_A}`, `asset-cat-${CAT_B}`, `asset-cat-${CAT_U}`]);
  await page.close();
});

test('an autocomplete suggestion appears for a held token as the user types', async () => {
  const page = await openWallet();
  await page.getByTestId(`asset-cat-${CAT_B}`).waitFor({ timeout: 25_000 });

  const input = page.getByTestId('asset-filter-input');
  await input.fill('bet');
  // Resolve the associated <datalist> via the input's `.list` IDREF property rather than building a
  // CSS id selector — React's `useId()` value contains `:`, which is invalid unescaped in a selector.
  const options = await input.evaluate((el: HTMLInputElement) => [...(el.list?.querySelectorAll('option') ?? [])].map((o) => (o as HTMLOptionElement).value));
  expect(options).toContain('BBB');
  await page.close();
});

test('a query matching nothing shows the clear empty state, and Clear restores the full list', async () => {
  const page = await openWallet();
  await page.getByTestId(`asset-cat-${CAT_A}`).waitFor({ timeout: 25_000 });

  await page.getByTestId('asset-filter-input').fill('nonexistent-token-zzz');
  await expect(page.getByTestId('custody-assets-filter-empty')).toBeVisible();
  await expect(page.getByTestId(`asset-cat-${CAT_A}`)).toHaveCount(0);
  // The pinned block (#204) is unaffected even by a query matching nothing in the CAT list.
  await expect(page.getByTestId('asset-xch')).toBeVisible();
  await expect(page.getByTestId('asset-dig')).toBeVisible();

  await page.getByTestId('asset-filter-clear').click();
  await expect(page.getByTestId('custody-assets-filter-empty')).toHaveCount(0);
  await expect(page.getByTestId(`asset-cat-${CAT_A}`)).toBeVisible();
  await expect(page.getByTestId(`asset-cat-${CAT_B}`)).toBeVisible();
  await page.close();
});

// Visual capture (§6.5) — the ordered + filterable Assets list at phone (popup) + tablet (fullscreen) widths.
for (const [label, file, size] of [
  ['popup', 'popup.html', { width: 372, height: 640 }],
  ['fullscreen', 'app.html', { width: 1200, height: 860 }],
] as const) {
  test(`screenshot: value-ordered assets list with the filter field (${label})`, async () => {
    const page = await context.newPage();
    await page.setViewportSize(size);
    await page.goto(`chrome-extension://${extensionId}/${file}#wallet`);
    await page.getByTestId(`asset-cat-${CAT_A}`).waitFor({ timeout: 25_000 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: `e2e/__screenshots__/asset-list-order-filter-${label}.png` });
    await page.close();
  });
}
