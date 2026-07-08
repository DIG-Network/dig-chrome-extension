/**
 * Content-quality gate for the Control-tab copy (#82 follow-on from #131's clarity bar), now that
 * `dig-control.ts` returns message ids rather than raw prose (§6.4 — `ControlTab.tsx` is the sole
 * `FormattedMessage` consumer). These assertions used to run directly against `dig-control.ts`'s
 * return values; they now run against the English catalog entries the view model's ids select, so
 * the "no jargon" / "full experience" / "honest read-fallback" bar still holds on the SOURCE OF
 * TRUTH catalog (the 13-locale completeness gate in `locales.test.ts` keeps every translation
 * present + placeholder-consistent).
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { en } from '@/i18n/messages/en';

test('control.note.* affirms the full DIG experience, in plain language', () => {
  assert.match(en['control.note.default'], /full/i);
  assert.match(en['control.note.authRequired'], /DIG Browser|native/i);
});

test('control.readFallback.* — manage mode never claims hosted reads; install mode names the hosted fallback', () => {
  assert.match(en['control.readFallback.local'], /local/i);
  assert.ok(!/hosted network/i.test(en['control.readFallback.local']), 'manage mode must not say reads use the hosted network');
  assert.match(en['control.readFallback.hosted'], /\{endpoint\}|hosted/i);
});

test('control.install.title/body is plain-language, names the dig-node, no jargon', () => {
  const title = en['control.install.title'];
  const body = en['control.install.body'];
  assert.match(body, /dig-node/i, 'should name the dig-node');
  assert.match(title + ' ' + body, /install|download|run/i);
  // Honest about the hosted fallback: reads keep working without a node.
  assert.match(body, /hosted|rpc\.dig\.net|without/i);
  // CLARITY (#131): the copy must make clear the node is needed for the FULL experience + running.
  assert.match(title + ' ' + body, /full experience/i, 'should sell the full experience');
  assert.match(body, /read-only|running/i, 'should say the node must run / without it is read-only');
  // No protocol jargon leaking into the default copy.
  assert.ok(!/retrieval[_\s-]?key|merkle|singleton|CHIP-?0035/i.test(title + ' ' + body));
});

test('control.stats interpolates the hosted/cached counts', () => {
  assert.match(en['control.stats'], /\{hosted\}/);
  assert.match(en['control.stats'], /\{cached\}/);
});
