/**
 * Tests for the branded, plain-language error page (error-page.mjs).
 *
 * The extension used to render raw dark `Error: <message>` pages that leaked internal
 * crypto strings (e.g. "decrypt failed (decoy or wrong key)") straight to the user. This
 * module renders ONE white-themed, friendly page with a plain-language cause and a recovery
 * action — and it must NEVER surface internal failure strings.
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildErrorPageHtml, friendlyCause, INTERNAL_LEAK_PATTERNS } from '../error-page.mjs';

test('never leaks "decoy or wrong key" (or other internal crypto strings) to the user', () => {
  const html = buildErrorPageHtml({
    url: 'chia://urn:dig:chia:abc',
    rawMessage: 'decrypt failed (decoy or wrong key)',
  });
  assert.ok(!/decoy/i.test(html), 'must not contain "decoy"');
  assert.ok(!/wrong key/i.test(html), 'must not contain "wrong key"');
  assert.ok(!/decrypt failed/i.test(html), 'must not contain "decrypt failed"');
});

test('shows the friendly, plain-language explanation', () => {
  const html = buildErrorPageHtml({ url: 'chia://x', rawMessage: 'anything' });
  assert.ok(
    /couldn.t be loaded/i.test(html),
    'should explain the page could not be loaded'
  );
  assert.ok(
    /unreachable|may not exist/i.test(html),
    'should give friendly causes (unreachable / may not exist)'
  );
});

test('uses the white product theme, not the legacy dark palette', () => {
  const html = buildErrorPageHtml({ url: 'chia://x', rawMessage: 'boom' });
  assert.ok(!/#1a0a2e/i.test(html), 'must not use the legacy dark #1a0a2e background');
  assert.ok(/#f7f7fb|#ffffff|#fff\b/i.test(html), 'should use the white product background');
});

test('includes a recovery action (try again / go to DIG Home)', () => {
  const html = buildErrorPageHtml({ url: 'chia://x', rawMessage: 'boom' });
  assert.ok(/try again|reload|DIG Home|dig\.net/i.test(html), 'should offer a recovery action');
});

test('escapes the URL so it cannot inject markup', () => {
  const html = buildErrorPageHtml({
    url: 'chia://<script>alert(1)</script>',
    rawMessage: 'boom',
  });
  assert.ok(!/<script>alert/i.test(html), 'URL must be HTML-escaped');
  assert.ok(/&lt;script&gt;/i.test(html), 'URL should appear escaped');
});

test('produces a full HTML document', () => {
  const html = buildErrorPageHtml({ url: 'chia://x', rawMessage: 'boom' });
  assert.ok(/<!DOCTYPE html>/i.test(html));
  assert.ok(/<\/html>/i.test(html));
});

test('friendlyCause maps a decrypt/decoy failure to a non-leaking message', () => {
  const msg = friendlyCause('decrypt failed (decoy or wrong key)');
  assert.ok(!/decoy|wrong key|decrypt/i.test(msg));
  assert.ok(msg.length > 0);
});

test('friendlyCause maps a network failure to an "unreachable" message', () => {
  const msg = friendlyCause('Failed to fetch');
  assert.ok(/unreachable|network|connection/i.test(msg));
});

test('INTERNAL_LEAK_PATTERNS is a non-empty list of RegExp', () => {
  assert.ok(Array.isArray(INTERNAL_LEAK_PATTERNS) && INTERNAL_LEAK_PATTERNS.length > 0);
  for (const p of INTERNAL_LEAK_PATTERNS) assert.ok(p instanceof RegExp);
});

test('renders an "Install dig-node" action when an installPrompt is provided', () => {
  const html = buildErrorPageHtml({
    url: 'chia://x',
    rawMessage: 'dig-node not running',
    installPrompt: {
      installLabel: 'Install dig-node',
      installUrl: 'https://github.com/DIG-Network/dig-installer/releases',
    },
  });
  assert.ok(/Install dig-node/i.test(html), 'should show the install action');
  assert.ok(
    /github\.com\/DIG-Network\/dig-installer\/releases/i.test(html),
    'should link to the installer releases page'
  );
});

test('does NOT render an install action when no installPrompt is given (generic error)', () => {
  const html = buildErrorPageHtml({ url: 'chia://x', rawMessage: 'dig RPC HTTP error 500' });
  assert.ok(!/dig-installer/i.test(html), 'generic errors must not show the installer link');
});

test('the install action url is HTML-escaped (cannot inject markup)', () => {
  const html = buildErrorPageHtml({
    url: 'chia://x',
    rawMessage: 'boom',
    installPrompt: { installLabel: 'Install', installUrl: 'https://x/"><script>alert(1)</script>' },
  });
  assert.ok(!/<script>alert/i.test(html), 'install url must be escaped');
});
