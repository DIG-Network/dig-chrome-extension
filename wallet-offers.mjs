/**
 * Wallet offers view-model — the pure (no DOM / chrome.*) model behind the Offers view
 * (make / inspect / take / cancel), brokered to Sage over WalletConnect.
 *
 * Mirrors the native DIG Browser wallet's Trades page but targets the SAGE WalletConnect offer
 * surface (the param shapes verified against hub.dig.net's Sage consumer):
 *   - `chia_createOffer` → `{ offerAssets:[{assetId, amount}], requestAssets:[{assetId, amount}], fee }`
 *     with `assetId:""` for XCH and amounts in BASE UNITS (whole units × 10^decimals);
 *   - `chia_takeOffer` / `chia_cancelOffer` → the pasted `offer1…` string (+ fee);
 *   - `chia_getOfferSummary` → tolerantly normalised into two legs for display.
 *
 * All conversion/validation lives here so the renderer stays thin glue and can't silently
 * regress the offer math.
 */

import { resolveSendAsset, normalizeCatId } from './wallet-assets.mjs';
import { toBaseUnits, formatBaseUnits } from './wallet-view.mjs';
import { DIG_ASSET_ID } from './links.mjs';

/** Validate a pasted offer string — must be a non-empty bech32 `offer1…`. */
export function validateOfferString(str) {
  const s = String(str == null ? '' : str).trim();
  if (!s) return { ok: false, error: 'Paste an offer1… string.' };
  if (!/^offer1/i.test(s)) return { ok: false, error: 'That does not look like an offer1… string.' };
  return { ok: true, error: null };
}

/** Convert an optional XCH fee (whole XCH) to mojos; blank → 0. Returns a number or null (invalid). */
function feeToMojos(fee) {
  const s = String(fee == null ? '' : fee).trim();
  if (s === '') return 0;
  const f = Number(s);
  if (!Number.isFinite(f) || f < 0) return null;
  return Math.round(f * 1e12);
}

/** Build one Sage offer leg `{assetId, amount}` from a picker value + whole-unit amount. */
function buildLeg(value, amount, watchedCats) {
  const asset = resolveSendAsset(value, watchedCats);
  if (!asset) return { error: 'Unknown asset in this offer.' };
  let base;
  try {
    base = toBaseUnits(amount, asset.decimals);
  } catch (e) {
    return { error: (e && e.message) || 'Enter a positive amount.' };
  }
  // Sage names XCH with an empty assetId; a CAT uses its TAIL.
  return { leg: { assetId: asset.assetId || '', amount: base } };
}

/**
 * Build `chia_createOffer` params from the Make-an-offer form. `giveValue`/`getValue` are Send
 * picker values (`'xch'` | `'dig'` | a tracked CAT TAIL); amounts are WHOLE units; `fee` is an
 * optional XCH fee. Returns `{ ok, params, error }` — `params` is
 * `{ offerAssets, requestAssets, fee }` on success.
 */
export function buildOfferParams({ giveValue, giveAmount, getValue, getAmount, watchedCats = [], fee = '' } = {}) {
  const give = buildLeg(giveValue, giveAmount, watchedCats);
  if (give.error) return { ok: false, params: null, error: give.error };
  const get = buildLeg(getValue, getAmount, watchedCats);
  if (get.error) return { ok: false, params: null, error: get.error };
  const feeMojos = feeToMojos(fee);
  if (feeMojos === null) return { ok: false, params: null, error: 'Fee must be zero or more.' };
  return {
    ok: true,
    error: null,
    params: { offerAssets: [give.leg], requestAssets: [get.leg], fee: feeMojos },
  };
}

/** Resolve an asset id (as it appears in an offer summary) to its ticker + display decimals. */
function assetInfo(rawAssetId) {
  const s = String(rawAssetId == null ? '' : rawAssetId).trim().toLowerCase();
  if (!s || s === 'xch' || s === 'null' || s === '0') return { ticker: 'XCH', decimals: 12 };
  const id = normalizeCatId(s);
  if (id && id === normalizeCatId(DIG_ASSET_ID)) return { ticker: '$DIG', decimals: 3, assetId: id };
  return { ticker: 'CAT', decimals: 3, assetId: id || s };
}

/** Normalise one offer leg collection (array of {assetId,amount} OR a {assetId:amount} map). */
function normalizeLegs(legs) {
  const out = [];
  if (Array.isArray(legs)) {
    for (const l of legs) {
      if (!l || typeof l !== 'object') continue;
      const info = assetInfo(l.assetId ?? l.asset_id ?? l.asset);
      out.push({ ticker: info.ticker, assetId: info.assetId || null, amountLabel: formatBaseUnits(l.amount, info.decimals) });
    }
  } else if (legs && typeof legs === 'object') {
    for (const [key, amount] of Object.entries(legs)) {
      const info = assetInfo(key);
      out.push({ ticker: info.ticker, assetId: info.assetId || null, amountLabel: formatBaseUnits(amount, info.decimals) });
    }
  }
  return out;
}

/**
 * Tolerantly normalise a `chia_getOfferSummary` response into `{ offered, requested, fee,
 * feeLabel }` for display. Handles both array-shaped legs and `{assetId: amount}` maps, and any
 * unknown shape degrades to empty legs (never throws) so the Inspect view can show an honest
 * "couldn't summarise" fallback.
 */
export function offerSummaryViewModel(raw, { watchedCats = [] } = {}) {
  const src = (raw && typeof raw === 'object' && (raw.summary || raw.data || raw)) || {};
  const offered = normalizeLegs(src.offered ?? src.offer ?? src.offerAssets ?? src.maker);
  const requested = normalizeLegs(src.requested ?? src.request ?? src.requestAssets ?? src.taker);
  const fee = Number(src.fee);
  const feeLabel = Number.isFinite(fee) && fee > 0 ? `${formatBaseUnits(fee, 12)} XCH` : '';
  return { offered, requested, fee: Number.isFinite(fee) ? fee : 0, feeLabel };
}
