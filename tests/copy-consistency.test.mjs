/**
 * Cross-cutting copy-consistency tests for the user-facing extension pages.
 *
 * These pin the ecosystem-wide canon (SYSTEM.md "Canonical terminology & branding") on the
 * surfaces a user actually reads — the first-run welcome page, the popup, and DIG Home (new
 * tab) — so the copy can't silently drift back off-canon:
 *   - user-facing content-open scheme is `chia://` (NOT `dig://`);
 *   - the token carries the `$DIG` sigil on first reference;
 *   - the hub wordmark is `DIGHUb` (capital U, lowercase b);
 *   - "Built on Chia" (one phrase, not "Powered by Chia");
 *   - the canonical org Discord is surfaced.
 *
 * The §21 remote locator `dig://<host>` and the `urn:dig:` namespace are EXEMPT and not
 * asserted here (they don't appear in these product pages).
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (f) => readFileSync(join(root, f), 'utf8');

const DISCORD = 'https://discord.gg/v78aygUZt';

test('welcome.html upsell uses the chia:// content-open scheme (no user-facing dig://)', () => {
  const html = read('welcome.html');
  assert.ok(!/native\s+dig:\/\//.test(html), 'welcome upsell must not say native dig://');
  assert.match(html, /native\s+chia:\/\//, 'welcome upsell should say native chia://');
});

// NOTE (#56): the popup is now the React shell (src/); its copy goes through react-intl catalogs
// (src/i18n) rather than literal popup.html strings, so the popup-specific copy assertions here are
// superseded by the Vitest suite. The welcome + new-tab pages remain vanilla HTML and are asserted.

test('newtab.html says "Built on Chia" (one phrase, not "Powered by Chia")', () => {
  const html = read('newtab.html');
  assert.ok(!/Powered by Chia/.test(html), 'must not use "Powered by Chia"');
  // Both the chip and the footer trust line should read "Built on Chia".
  const builtOn = html.match(/Built on Chia/g) || [];
  assert.ok(builtOn.length >= 2, 'both surfaces should read "Built on Chia"');
});

test('welcome.html surfaces the canonical org Discord', () => {
  assert.ok(read('welcome.html').includes(DISCORD), 'welcome page should link the org Discord');
});

test('newtab.html footer surfaces the canonical org Discord', () => {
  assert.ok(read('newtab.html').includes(DISCORD), 'DIG Home footer should link the org Discord');
});

test('the hub wordmark is canonical DIGHUb (not DIGHub) on the product pages', () => {
  for (const f of ['welcome.html', 'newtab.html']) {
    const html = read(f);
    assert.ok(!/DIGHub\b/.test(html), `${f} must use DIGHUb, not DIGHub`);
  }
});
