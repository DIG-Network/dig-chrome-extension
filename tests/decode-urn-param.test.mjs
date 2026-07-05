/**
 * Regression tests for decodeUrnParam (dig-urn.mjs) — the fix for the dig-viewer failing to load a
 * URL-ENCODED `urn` query param.
 *
 * BUG: the viewer reads `?urn=` via URLSearchParams (which decodes exactly once). Several navigation
 * entry points (address bar, link click, protocol-error, search/omnibox redirect) can hand the
 * background a percent-encoded `chia://` URL, which then gets encoded AGAIN into the viewer URL — so
 * after one decode the value is still `chia%3A%2F%2F…` and parseURN rejects it → nothing loads.
 *
 * decodeUrnParam decodes percent-escapes until the value is stable. A valid DIG URN contains no
 * literal `%`, so decoding while a `%XX` escape remains never corrupts a well-formed URN.
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeUrnParam, parseURN } from '../dig-urn.mjs';

const STORE = 'a'.repeat(64);
const ROOT = 'b'.repeat(64);
const URN = `chia://chia:${STORE}:${ROOT}/index.html`;

// Emulate the viewer read: URLSearchParams.get() decodes exactly once.
const getParam = (encoded) => new URLSearchParams('urn=' + encoded).get('urn');

test('decodeUrnParam leaves an already-decoded URN untouched', () => {
  assert.equal(decodeUrnParam(URN), URN);
  assert.equal(decodeUrnParam(`chia://chia:${STORE}/a.js`), `chia://chia:${STORE}/a.js`);
});

test('decodeUrnParam decodes a still-encoded value (double-encoded param)', () => {
  // Viewer built ?urn=encodeURIComponent(encodeURIComponent(urn)); one URLSearchParams decode
  // leaves it percent-encoded — decodeUrnParam finishes the job.
  const afterOneDecode = getParam(encodeURIComponent(encodeURIComponent(URN)));
  assert.match(afterOneDecode, /%3A/i); // still encoded after the single URLSearchParams decode
  assert.equal(decodeUrnParam(afterOneDecode), URN);
});

test('decodeUrnParam is idempotent over multiple encodings', () => {
  assert.equal(decodeUrnParam(encodeURIComponent(encodeURIComponent(encodeURIComponent(URN)))), URN);
});

test('a double-encoded urn param only parses AFTER decodeUrnParam (the bug + fix)', () => {
  const afterOneDecode = getParam(encodeURIComponent(encodeURIComponent(URN)));
  // The bug: parsing the raw once-decoded value fails.
  assert.equal(parseURN(afterOneDecode.replace(/^chia:\/\//, '')), null);
  // The fix: decode-until-stable first, then it parses to the right capsule.
  const fixed = decodeUrnParam(afterOneDecode);
  const parsed = parseURN(fixed.replace(/^chia:\/\//, ''));
  assert.ok(parsed);
  assert.equal(parsed.storeId, STORE);
  assert.equal(parsed.roothash, ROOT);
  assert.equal(parsed.resourceKey, 'index.html');
});

test('decodeUrnParam preserves a legitimate ?salt= query through decoding', () => {
  const salted = `chia://chia:${STORE}/secret.txt?salt=deadbeef`;
  assert.equal(decodeUrnParam(getParam(encodeURIComponent(encodeURIComponent(salted)))), salted);
});

test('decodeUrnParam handles non-string + malformed percent input without throwing', () => {
  assert.equal(decodeUrnParam(null), '');
  assert.equal(decodeUrnParam(undefined), '');
  assert.equal(decodeUrnParam(''), '');
  // A lone, malformed `%` is not a valid escape — returned unchanged rather than throwing.
  assert.equal(decodeUrnParam('100%'), '100%');
});
