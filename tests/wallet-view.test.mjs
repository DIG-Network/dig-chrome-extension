/**
 * Pure wallet view-model tests.
 *
 * wallet-view.mjs holds the popup wallet's presentation + input logic with NO DOM/chrome.*:
 * balance-unit conversion (XCH mojos ÷ 1e12, $DIG base units ÷ 1000), tolerant balance-field
 * extraction from Sage's varied getAssetBalance response casings, send-amount → base-unit
 * conversion, send-form validation, address shortening, and the activity list view model. The
 * popup renderer (popup-wallet.js) is thin glue over these tested pure functions, so the
 * wallet's number handling and validation can't silently regress.
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  XCH_MOJOS_PER_UNIT,
  DIG_BASE_UNITS_PER_UNIT,
  pickBalance,
  formatXch,
  formatDig,
  formatAssetBalance,
  toBaseUnits,
  shortenAddress,
  validateSendForm,
  activityViewModel,
} from '../wallet-view.mjs';

test('unit constants match Chia (XCH = 1e12 mojos, $DIG = 1000 base units / 3 decimals)', () => {
  assert.equal(XCH_MOJOS_PER_UNIT, 1_000_000_000_000);
  assert.equal(DIG_BASE_UNITS_PER_UNIT, 1000);
});

test('pickBalance tolerates every Sage response casing and returns a number or null', () => {
  assert.equal(pickBalance({ confirmed: 5 }), 5);
  assert.equal(pickBalance({ spendable: 7 }), 7);
  assert.equal(pickBalance({ confirmedWalletBalance: 9 }), 9);
  assert.equal(pickBalance({ confirmed_wallet_balance: 11 }), 11);
  assert.equal(pickBalance({ balance: 13 }), 13);
  assert.equal(pickBalance({ data: { confirmed: 15 } }), 15);
  assert.equal(pickBalance(17), 17);
  assert.equal(pickBalance('19'), 19);
  // prefers confirmed over spendable when both present
  assert.equal(pickBalance({ confirmed: 3, spendable: 99 }), 3);
  // unknown / unavailable → null (never a false 0)
  assert.equal(pickBalance(null), null);
  assert.equal(pickBalance(undefined), null);
  assert.equal(pickBalance({}), null);
  assert.equal(pickBalance({ confirmed: 'nan' }), null);
});

test('formatXch converts mojos to XCH and trims trailing zeros', () => {
  assert.equal(formatXch(1_000_000_000_000), '1');
  assert.equal(formatXch(1_500_000_000_000), '1.5');
  assert.equal(formatXch(0), '0');
  assert.equal(formatXch(1), '0.000000000001');
  assert.equal(formatXch(null), '—');
});

test('formatDig converts base units to $DIG at 3 decimals', () => {
  assert.equal(formatDig(1000), '1');
  assert.equal(formatDig(1500), '1.5');
  assert.equal(formatDig(1), '0.001');
  assert.equal(formatDig(0), '0');
  assert.equal(formatDig(null), '—');
});

test('formatAssetBalance dispatches on asset and reads the balance field', () => {
  assert.equal(formatAssetBalance({ confirmed: 2_000_000_000_000 }, 'xch'), '2');
  assert.equal(formatAssetBalance({ confirmed: 2500 }, 'dig'), '2.5');
  assert.equal(formatAssetBalance(null, 'xch'), '—');
});

test('toBaseUnits converts a human amount string to the asset base unit (integer)', () => {
  assert.equal(toBaseUnits('1', 'xch'), 1_000_000_000_000);
  assert.equal(toBaseUnits('0.5', 'xch'), 500_000_000_000);
  assert.equal(toBaseUnits('1', 'dig'), 1000);
  assert.equal(toBaseUnits('2.5', 'dig'), 2500);
  // rounds to the nearest base unit (no fractional mojos)
  assert.equal(toBaseUnits('0.0015', 'dig'), 2); // 1.5 base units → 2
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

test('activityViewModel normalises Sage tx shapes to a capped, newest-first list', () => {
  const raw = {
    transactions: [
      { name: 'a', type: 'OUTGOING', amount: 1_000_000_000_000, created_at_time: 100, memos: ['hi'] },
      { name: 'b', sent: 0, amount: 500, assetId: 'a406', createdAtTime: 200 },
    ],
  };
  const vm = activityViewModel(raw, { digAssetId: 'a406' });
  assert.equal(vm.length, 2);
  // newest-first (created 200 before created 100)
  assert.equal(vm[0].id, 'b');
  assert.equal(vm[0].direction, 'in');
  assert.equal(vm[0].asset, 'dig');
  assert.equal(vm[1].direction, 'out');
  assert.equal(vm[1].asset, 'xch');
  assert.ok(vm[1].amountLabel);
});

test('activityViewModel tolerates empty / missing input', () => {
  assert.deepEqual(activityViewModel(null), []);
  assert.deepEqual(activityViewModel({}), []);
  assert.deepEqual(activityViewModel([]), []);
});
