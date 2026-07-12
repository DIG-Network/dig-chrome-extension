/**
 * Pure wallet view-model tests.
 *
 * wallet-view.ts holds the popup wallet's presentation + input logic with NO DOM/chrome.*:
 * base-unit ↔ whole-unit conversion (XCH = 12 decimals, CATs incl. $DIG = 3), human-amount →
 * base-unit conversion, send-form validation, and address shortening / `xch1` format-gating. The
 * React wallet shell is thin glue over these tested pure functions, so the wallet's number handling
 * and validation can't silently regress.
 *
 * Run: node --test tests/
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  formatBaseUnits,
  toBaseUnits,
  shortenAddress,
  isChiaAddress,
  validateSendForm,
} from '@/lib/wallet-view';

test('toBaseUnits converts a human amount string to the asset base unit (integer)', () => {
  assert.equal(toBaseUnits('1', 'xch'), 1_000_000_000_000);
  assert.equal(toBaseUnits('0.5', 'xch'), 500_000_000_000);
  assert.equal(toBaseUnits('1', 'dig'), 1000);
  assert.equal(toBaseUnits('2.5', 'dig'), 2500);
  // rounds to the nearest base unit (no fractional mojos)
  assert.equal(toBaseUnits('0.0015', 'dig'), 2); // 1.5 base units → 2
});

test('toBaseUnits also accepts a decimals number (for arbitrary CATs / fees)', () => {
  assert.equal(toBaseUnits('1', 12), 1_000_000_000_000);
  assert.equal(toBaseUnits('2', 3), 2000);
  assert.equal(toBaseUnits('0.001', 12), 1_000_000_000); // fee in XCH → mojos
  assert.throws(() => toBaseUnits('0', 3));
});

test('formatBaseUnits renders an integer at N decimals, trimming zeros; null → em dash', () => {
  assert.equal(formatBaseUnits(1_000_000_000_000, 12), '1');
  assert.equal(formatBaseUnits(2500, 3), '2.5');
  assert.equal(formatBaseUnits(0, 3), '0');
  assert.equal(formatBaseUnits(null, 12), '—');
  assert.equal(formatBaseUnits('nan', 3), '—');
});

test('formatBaseUnits serves an asset KEY as well as a decimals number', () => {
  assert.equal(formatBaseUnits(1_500_000_000_000, 'xch'), '1.5');
  assert.equal(formatBaseUnits(1500, 'dig'), '1.5');
  assert.equal(formatBaseUnits(1, 'xch'), '0.000000000001');
});

test('toBaseUnits throws on non-positive / non-numeric input', () => {
  assert.throws(() => toBaseUnits('0', 'xch'));
  assert.throws(() => toBaseUnits('-1', 'xch'));
  assert.throws(() => toBaseUnits('abc', 'xch'));
  assert.throws(() => toBaseUnits('', 'dig'));
});

test('shortenAddress keeps a readable head…tail; short/empty pass through', () => {
  assert.equal(
    shortenAddress('xch1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqzzzzzzzz'),
    'xch1qqqqqq…zzzzzzzz',
  );
  assert.equal(shortenAddress(''), '');
  assert.equal(shortenAddress('xch1short'), 'xch1short');
});

test('isChiaAddress format-gates xch1 bech32 strings', () => {
  assert.equal(isChiaAddress('xch1qqqqqqrealish'), true);
  assert.equal(isChiaAddress('nope'), false);
  assert.equal(isChiaAddress(''), false);
  assert.equal(isChiaAddress(null), false);
});

test('validateSendForm requires an xch1 address and a positive amount', () => {
  assert.deepEqual(
    validateSendForm({ address: 'xch1qqqqqqrealish', amount: '1', asset: 'xch' }),
    { ok: true, errors: {} },
  );
  const bad = validateSendForm({ address: 'nope', amount: '0', asset: 'xch' });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.address);
  assert.ok(bad.errors.amount);
  const noAddr = validateSendForm({ address: '', amount: '1', asset: 'dig' });
  assert.equal(noAddr.ok, false);
  assert.ok(noAddr.errors.address);
});

test('validateSendForm accepts a blank/zero fee and rejects a negative/non-numeric fee', () => {
  const ok = validateSendForm({ address: 'xch1qqqqqqrealish', amount: '1', fee: '' });
  assert.equal(ok.ok, true);
  const okZero = validateSendForm({ address: 'xch1qqqqqqrealish', amount: '1', fee: '0' });
  assert.equal(okZero.ok, true);
  const neg = validateSendForm({ address: 'xch1qqqqqqrealish', amount: '1', fee: '-1' });
  assert.equal(neg.ok, false);
  assert.ok(neg.errors.fee);
  const nan = validateSendForm({ address: 'xch1qqqqqqrealish', amount: '1', fee: 'abc' });
  assert.equal(nan.ok, false);
  assert.ok(nan.errors.fee);
});
