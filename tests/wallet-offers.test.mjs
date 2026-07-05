/**
 * Wallet offers view-model tests.
 *
 * wallet-offers.mjs is the pure (no DOM / chrome.*) model behind the wallet's Offers view —
 * make / inspect / take / cancel — brokered to Sage. It mirrors the native DIG Browser wallet's
 * Trades page but targets the SAGE WalletConnect offer surface (verified against hub.dig.net):
 *   - createOffer → `{ offerAssets:[{assetId, amount}], requestAssets:[{assetId, amount}], fee }`
 *     with assetId "" for XCH and amounts in base units (whole units × 10^decimals);
 *   - takeOffer / cancelOffer → the pasted `offer1…` string;
 *   - getOfferSummary → a tolerant render model of the two legs.
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateOfferString,
  buildOfferParams,
  offerSummaryViewModel,
} from '../wallet-offers.mjs';
import { DIG_ASSET_ID } from '../links.mjs';

test('validateOfferString requires a non-empty offer1… string', () => {
  assert.equal(validateOfferString('offer1qqq...').ok, true);
  const empty = validateOfferString('   ');
  assert.equal(empty.ok, false);
  assert.ok(empty.error);
  const wrong = validateOfferString('xch1abc');
  assert.equal(wrong.ok, false);
  assert.ok(wrong.error);
});

test('buildOfferParams converts whole units to base units per asset (XCH assetId "")', () => {
  const r = buildOfferParams({
    giveValue: 'xch', giveAmount: '1',
    getValue: 'dig', getAmount: '10',
    watchedCats: [], fee: '',
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.params.offerAssets, [{ assetId: '', amount: 1_000_000_000_000 }]);
  assert.deepEqual(r.params.requestAssets, [{ assetId: DIG_ASSET_ID, amount: 10_000 }]);
  assert.equal(r.params.fee, 0);
});

test('buildOfferParams supports a tracked CAT leg and an explicit XCH fee', () => {
  const c = 'c'.repeat(64);
  const r = buildOfferParams({
    giveValue: c, giveAmount: '2',
    getValue: 'xch', getAmount: '0.5',
    watchedCats: [{ assetId: c, name: 'Gamma' }], fee: '0.001',
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.params.offerAssets, [{ assetId: c, amount: 2_000 }]);
  assert.deepEqual(r.params.requestAssets, [{ assetId: '', amount: 500_000_000_000 }]);
  assert.equal(r.params.fee, 1_000_000_000); // 0.001 XCH in mojos
});

test('buildOfferParams rejects a non-positive amount or an unknown asset', () => {
  const badAmt = buildOfferParams({ giveValue: 'xch', giveAmount: '0', getValue: 'dig', getAmount: '1', watchedCats: [] });
  assert.equal(badAmt.ok, false);
  assert.ok(badAmt.error);

  const unknown = buildOfferParams({ giveValue: 'mystery', giveAmount: '1', getValue: 'xch', getAmount: '1', watchedCats: [] });
  assert.equal(unknown.ok, false);
  assert.ok(unknown.error);
});

test('offerSummaryViewModel tolerates array-shaped legs', () => {
  const c = 'c'.repeat(64);
  const vm = offerSummaryViewModel(
    {
      offered: [{ assetId: null, amount: 1_000_000_000_000 }],
      requested: [{ assetId: c, amount: 3_000 }],
      fee: 500,
    },
    { watchedCats: [{ assetId: c, name: 'Gamma' }] },
  );
  assert.equal(vm.offered.length, 1);
  assert.equal(vm.offered[0].ticker, 'XCH');
  assert.equal(vm.offered[0].amountLabel, '1');
  assert.equal(vm.requested[0].ticker, 'CAT');
  assert.equal(vm.requested[0].amountLabel, '3');
  assert.ok(vm.feeLabel);
});

test('offerSummaryViewModel tolerates map-shaped legs and unknown shapes', () => {
  // Sage may return offered/requested keyed by assetId → amount.
  const vm = offerSummaryViewModel(
    { offered: { xch: 2_000_000_000_000 }, requested: { [DIG_ASSET_ID]: 5_000 } },
    { watchedCats: [] },
  );
  assert.equal(vm.offered[0].amountLabel, '2');
  assert.equal(vm.requested[0].ticker, '$DIG');
  assert.equal(vm.requested[0].amountLabel, '5');

  // Completely unknown → empty legs, never throws.
  const empty = offerSummaryViewModel(null, {});
  assert.deepEqual(empty.offered, []);
  assert.deepEqual(empty.requested, []);
});
