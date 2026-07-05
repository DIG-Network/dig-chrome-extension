/**
 * Tests that the driveable UI surfaces (options, viewer) carry stable data-testid hooks + ARIA
 * landmarks/roles so an agent can drive and assert on them deterministically, without scraping CSS
 * classes or visible text. These pin the agent-friendly affordances so they can't silently regress
 * while the human UX stays untouched.
 *
 * NOTE (#56): the POPUP + full-page wallet UI is now the React shell (src/), not a hand-written
 * popup.html. Its data-testid / ARIA-role / four-state / theme coverage lives in the Vitest + RTL
 * suite (src/test/app.test.tsx + the per-component *.test.tsx), which renders the real components.
 * This node-test file therefore covers only the surfaces that remain vanilla HTML: options.html and
 * dig-viewer.html. The shared DIG product THEME (white ground + violet→magenta accent) is asserted
 * against src/styles/theme.css below.
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(root, f), 'utf8');

test('the React shell uses the DIG product theme (white ground + violet→magenta accent)', () => {
  const css = read('src/styles/theme.css');
  // White ground + the DIG purple/magenta accent define the product theme (palette in CSS vars).
  assert.match(css, /--dig-bg:\s*#ffffff/i, 'theme.css should ground the surface in white (#ffffff)');
  assert.match(css, /#7a3dff/i, 'theme.css should carry the DIG purple accent (#7A3DFF)');
  assert.match(css, /#c13de0/i, 'theme.css should carry the DIG magenta accent (#C13DE0)');
  // The popup HTML entry must not bake a color — the CSS owns the palette (theme portability).
  const html = read('popup.html');
  assert.ok(!/style="[^"]*background/i.test(html), 'popup.html must not inline a background color');
});

test('options.html exposes data-testid on every config control', () => {
  const html = read('options.html');
  for (const id of [
    'options-root', 'dignode-host-input', 'dignode-host-reset',
    'dignode-status', 'rpc-endpoint-input', 'rpc-endpoint-reset', 'wc-project-id-input',
  ]) {
    assert.match(html, new RegExp(`data-testid="${id}"`), `options.html missing data-testid="${id}"`);
  }
});

test('options.html keeps a <main> landmark and the section structure', () => {
  const html = read('options.html');
  assert.match(html, /<main[^>]*data-testid="options-root"/, 'options needs a main landmark');
  assert.match(html, /<header class="head">/, 'options header must still render');
});

test('dig-viewer.html exposes data-testid + ARIA on the verify banner and error mount', () => {
  const html = read('dig-viewer.html');
  assert.match(html, /data-testid="verify-banner"/);
  assert.match(html, /data-testid="error-mount"/);
  assert.match(html, /id="verifyBanner"[^>]*role="status"/, 'verify banner should be a status region');
  assert.match(html, /data-verified=/, 'banner should carry data-verified');
});

test('dig-viewer.js surfaces the machine error code as document data-dig-error', () => {
  const js = read('dig-viewer.js');
  assert.match(js, /data-dig-error/, 'viewer must expose the error code as a data-* attribute');
  assert.match(js, /data-dig-verified/, 'viewer must expose the verification verdict as a data-* attribute');
  assert.match(js, /response\.code/, 'viewer must pass through the coded envelope code');
});
