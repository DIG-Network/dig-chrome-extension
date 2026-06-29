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
    'browse-hub', 'open-options',
  ]) {
    assert.match(html, new RegExp(`data-testid="${id}"`), `popup.html missing data-testid="${id}"`);
  }
});

test('popup.html keeps the white product theme + ARIA on the verify status line', () => {
  const html = read('popup.html');
  assert.match(html, /role="main"/, 'popup root should be a main landmark');
  assert.match(html, /id="verifyLine"[^>]*role="status"/, 'verify line should be a status region');
  // White theme not regressed (the popup CSS owns the palette; the page must not bake a dark bg).
  assert.ok(!/#1a0a2e/i.test(html), 'must not introduce the legacy dark background');
});

test('popup.html exposes the verify verdict as a data-* attribute (not just class/text)', () => {
  const html = read('popup.html');
  assert.match(html, /id="verifyLine"[^>]*data-verified=/, 'verify line should carry data-verified');
});

test('options.html exposes data-testid on every config control', () => {
  const html = read('options.html');
  for (const id of [
    'options-root', 'cache-stat', 'clear-cache', 'dignode-host-input', 'dignode-host-reset',
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
