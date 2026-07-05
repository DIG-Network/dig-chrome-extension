/**
 * Tests that the driveable UI surfaces (popup, options, viewer) carry stable data-testid
 * hooks + ARIA landmarks/roles so an agent can drive and assert on them deterministically,
 * without scraping CSS classes or visible text. These pin the agent-friendly affordances so
 * they can't silently regress while the human UX stays untouched.
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

test('popup.html exposes data-testid on every primary control', () => {
  const html = read('popup.html');
  for (const id of [
    'popup-root', 'verify-line', 'wallet-connect', 'wallet-disconnect', 'get-dig',
    'chia-url-input', 'chia-url-go', 'resolution-toggle', 'status-text',
    'browse-hub', 'open-options', 'explore-dig',
    // The four tabs (Resolver · Wallet · Shield · Control Panel) + their panels.
    'tab-resolver', 'tab-wallet', 'tab-shield', 'tab-control',
    'resolver-panel', 'wallet-panel', 'shield-panel', 'control-panel',
    // Wallet subviews (assets / send / receive / activity / offers) + their controls.
    'wallet-assets', 'wallet-send', 'wallet-receive', 'wallet-activity', 'wallet-offers',
    'send-address', 'send-amount', 'send-fee', 'send-submit', 'wallet-address', 'receive-qr',
    'add-token-id', 'add-token-submit', 'send-asset',
    'offer-give-asset', 'offer-give-amount', 'offer-get-asset', 'offer-get-amount',
    'offer-make-submit', 'offer-take-string', 'offer-inspect', 'offer-take-submit',
    'offer-cancel-string', 'offer-cancel-submit', 'wallet-settings',
    // Resolver §5.3 node-config: custom-node override + the resolve-via verdict.
    'resolve-status', 'node-host-input', 'node-host-save',
  ]) {
    assert.match(html, new RegExp(`data-testid="${id}"`), `popup.html missing data-testid="${id}"`);
  }
});

test('popup.html organises the surface as an ARIA tablist of four tabs', () => {
  const html = read('popup.html');
  assert.match(html, /role="tablist"/, 'the tab bar should be an ARIA tablist');
  for (const tab of ['resolver', 'wallet', 'shield', 'control']) {
    assert.match(html, new RegExp(`data-tab="${tab}"`), `missing a tab button for ${tab}`);
  }
  // Each tab button is an ARIA tab controlling its panel; the active tab reflects aria-selected.
  assert.match(html, /role="tab"[^>]*aria-selected="true"/, 'the default tab should be aria-selected');
  // The Shield + Control tabs carry a machine-readable status dot (agent-readable verdict).
  assert.match(html, /id="shieldDot"[^>]*data-verified=/, 'shield dot should carry data-verified');
  assert.match(html, /id="controlDot"[^>]*data-node=/, 'control dot should carry data-node');
  // The control panel reports its mode (manage|install) as a data-* attribute.
  assert.match(html, /id="controlPanel"[^>]*data-mode=/, 'control panel should carry data-mode');
});

test('popup.html is a main landmark with an ARIA verify status line', () => {
  const html = read('popup.html');
  assert.match(html, /role="main"/, 'popup root should be a main landmark');
  assert.match(html, /id="verifyLine"[^>]*role="status"/, 'verify line should be a status region');
});

test('popup uses the DIG luxurious DARK theme (palette lives in popup.css, not baked in HTML)', () => {
  const css = read('popup.css');
  // The dark ground (#0B0A12-family) + the purple accent (#7A3DFF) define the theme.
  assert.match(css, /#0b0a12/i, 'popup.css should ground the surface in the DIG dark (#0B0A12)');
  assert.match(css, /#7a3dff/i, 'popup.css should lead with the DIG purple accent (#7A3DFF)');
  // The page itself must not bake colors — the CSS owns the palette (agent + theme portability).
  const html = read('popup.html');
  assert.ok(!/style="[^"]*background/i.test(html), 'popup.html must not inline a background color');
});

test('popup.html exposes the verify verdict as a data-* attribute (not just class/text)', () => {
  const html = read('popup.html');
  assert.match(html, /id="verifyLine"[^>]*data-verified=/, 'verify line should carry data-verified');
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
