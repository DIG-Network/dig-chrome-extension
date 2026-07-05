/**
 * Wallet asset-registry + CAT-tracking tests.
 *
 * wallet-assets.mjs is the pure (no DOM / chrome.*) model behind the wallet's Assets view and
 * the Send asset picker: the built-in asset registry (XCH + $DIG with their tickers/decimals),
 * the user's tracked-CAT list (add/remove/normalise by 32-byte TAIL, matching the native DIG
 * Browser wallet's "track a token by asset id"), the ordered balance rows to query, the picker
 * options, and the resolution of a picker value → the chia_send `{type, assetId}` params. All
 * balance/coin reads are Sage's wallet-wide AGGREGATE (across every HD address) — so a tracked
 * CAT's balance is one getAssetBalance call, no address enumeration.
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  XCH_META,
  DIG_META,
  normalizeCatId,
  parseWatchedCats,
  addWatchedCat,
  removeWatchedCat,
  assetDescriptors,
  sendAssetOptions,
  resolveSendAsset,
} from '../wallet-assets.mjs';
import { DIG_ASSET_ID } from '../links.mjs';

test('the built-in registry pins XCH (12 dp) and $DIG (3 dp, real TAIL)', () => {
  assert.equal(XCH_META.key, 'xch');
  assert.equal(XCH_META.ticker, 'XCH');
  assert.equal(XCH_META.decimals, 12);
  assert.equal(XCH_META.assetId, null);
  assert.equal(DIG_META.key, 'dig');
  assert.equal(DIG_META.ticker, '$DIG');
  assert.equal(DIG_META.decimals, 3);
  assert.equal(DIG_META.assetId, DIG_ASSET_ID);
});

test('normalizeCatId strips 0x + whitespace, lowercases, and validates 64-hex', () => {
  const id = 'A406D3A9DE984D03C9591C10D917593B434D5263CABE2B42F6B367DF16832F81';
  assert.equal(normalizeCatId('0x' + id), id.toLowerCase());
  assert.equal(normalizeCatId('  ' + id + '  '), id.toLowerCase());
  assert.equal(normalizeCatId(id.toLowerCase()), id.toLowerCase());
  // invalid → null (too short, non-hex, empty, nullish)
  assert.equal(normalizeCatId('deadbeef'), null);
  assert.equal(normalizeCatId('z'.repeat(64)), null);
  assert.equal(normalizeCatId(''), null);
  assert.equal(normalizeCatId(null), null);
  assert.equal(normalizeCatId(undefined), null);
});

test('parseWatchedCats tolerates junk and normalises to {assetId, name}', () => {
  const good = 'b'.repeat(64);
  assert.deepEqual(parseWatchedCats(null), []);
  assert.deepEqual(parseWatchedCats('not-an-array'), []);
  assert.deepEqual(
    parseWatchedCats([{ assetId: '0x' + good.toUpperCase(), name: 'Test' }]),
    [{ assetId: good, name: 'Test' }],
  );
  // bare-string entries + bad entries are tolerated / dropped
  assert.deepEqual(parseWatchedCats([good, { assetId: 'bad' }, 42]), [{ assetId: good, name: '' }]);
});

test('addWatchedCat validates, dedupes, and refuses XCH/$DIG', () => {
  const a = 'a'.repeat(64);
  const first = addWatchedCat([], a, 'Alpha');
  assert.equal(first.ok, true);
  assert.deepEqual(first.list, [{ assetId: a, name: 'Alpha' }]);

  // duplicate → rejected, list unchanged
  const dup = addWatchedCat(first.list, '0x' + a.toUpperCase());
  assert.equal(dup.ok, false);
  assert.ok(dup.error);
  assert.deepEqual(dup.list, first.list);

  // $DIG is built-in → rejected (already shown)
  const dig = addWatchedCat([], DIG_ASSET_ID);
  assert.equal(dig.ok, false);
  assert.ok(dig.error);

  // invalid id → rejected
  const bad = addWatchedCat([], 'nope');
  assert.equal(bad.ok, false);
  assert.ok(bad.error);
});

test('removeWatchedCat drops the matching TAIL (tolerating 0x/case) and no-ops otherwise', () => {
  const a = 'a'.repeat(64);
  const b = 'b'.repeat(64);
  const list = [{ assetId: a, name: 'A' }, { assetId: b, name: 'B' }];
  assert.deepEqual(removeWatchedCat(list, '0x' + a.toUpperCase()), [{ assetId: b, name: 'B' }]);
  assert.deepEqual(removeWatchedCat(list, 'c'.repeat(64)), list);
});

test('assetDescriptors lists XCH, $DIG, then each tracked CAT in order', () => {
  const c = 'c'.repeat(64);
  const rows = assetDescriptors([{ assetId: c, name: 'Gamma' }]);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].ticker, 'XCH');
  assert.equal(rows[1].ticker, '$DIG');
  assert.equal(rows[2].key, 'cat');
  assert.equal(rows[2].assetId, c);
  assert.equal(rows[2].name, 'Gamma');
  assert.equal(rows[2].decimals, 3);
});

test('sendAssetOptions offers XCH, $DIG, then each tracked CAT', () => {
  const c = 'c'.repeat(64);
  const opts = sendAssetOptions([{ assetId: c, name: 'Gamma' }]);
  assert.deepEqual(opts[0], { value: 'xch', label: 'XCH' });
  assert.deepEqual(opts[1], { value: 'dig', label: '$DIG' });
  assert.equal(opts[2].value, c);
  assert.match(opts[2].label, /Gamma/);
});

test('resolveSendAsset maps a picker value to chia_send {type, assetId} + decimals', () => {
  const c = 'c'.repeat(64);
  assert.deepEqual(resolveSendAsset('xch', []), { type: null, assetId: null, decimals: 12, ticker: 'XCH' });
  assert.deepEqual(resolveSendAsset('dig', []), { type: 'cat', assetId: DIG_ASSET_ID, decimals: 3, ticker: '$DIG' });
  const cat = resolveSendAsset(c, [{ assetId: c, name: 'Gamma' }]);
  assert.equal(cat.type, 'cat');
  assert.equal(cat.assetId, c);
  assert.equal(cat.decimals, 3);
  // unknown value → null (renderer falls back to XCH / shows an error)
  assert.equal(resolveSendAsset('mystery', []), null);
});
