/**
 * QR renderer tests.
 *
 * qr.mjs wraps the battle-tested `qrcode-generator` (MIT) to turn a string (a Chia receive
 * address, a WalletConnect pairing URI) into a scannable black-on-white SVG the popup injects
 * via innerHTML. The wrapper is pure (no DOM / chrome.*), so its output contract can be pinned:
 * correct <svg> dimensions, a white ground, and dark modules rendered as <rect>s. Mirrors the
 * native DIG Browser wallet's dig-wallet/wc/qr.js so the receive QR is byte-consistent across
 * the two wallet editions.
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { qrSvg } from '../qr.mjs';

test('qrSvg returns a sized SVG with a white ground and dark modules', () => {
  const svg = qrSvg('xch1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqzzzzzzzz', 200);
  assert.match(svg, /^<svg\b/, 'output should be an <svg> element');
  assert.match(svg, /width="200"/);
  assert.match(svg, /height="200"/);
  assert.match(svg, /viewBox="0 0 200 200"/);
  // A white background rect + at least one dark module rect.
  assert.match(svg, /fill="#fff"/, 'should paint a white ground');
  assert.match(svg, /fill="#000"/, 'should render dark modules');
  assert.ok((svg.match(/<rect/g) || []).length > 5, 'a QR has many module rects');
  assert.match(svg, /crispEdges/, 'should render crisp (no anti-alias blur)');
});

test('qrSvg defaults to a sensible size when none is given', () => {
  const svg = qrSvg('hello');
  assert.match(svg, /width="180"/, 'default size is 180px');
});

test('qrSvg encodes different inputs into different matrices', () => {
  const a = qrSvg('xch1aaa', 120);
  const b = qrSvg('xch1bbbbbbbbbbbbbbbbbbbbbbb', 120);
  assert.notEqual(a, b, 'distinct payloads produce distinct QR SVGs');
});
