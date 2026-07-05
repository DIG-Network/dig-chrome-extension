/**
 * Wallet view-model — the popup wallet's PURE presentation + input logic (no DOM / chrome.*).
 *
 * The extension can't run an in-process wallet, so balances/sends are brokered over
 * WalletConnect → Sage (see wallet-wc.js). Sage manages the HD wallet and returns
 * wallet-wide AGGREGATE balances (across all HD addresses) — the extension does NOT enumerate
 * addresses itself; "full-HD-wallet aggregate" is satisfied by asking Sage. This module owns
 * everything about how those values are turned into display + how user input is turned into
 * on-chain amounts, so it can be unit-tested and the renderer stays thin glue:
 *   - unit conversion: XCH mojos ÷ 1e12, $DIG base units ÷ 1000 (DIG has 3 decimals);
 *   - tolerant balance-field extraction across Sage's varied getAssetBalance response casings;
 *   - human-amount → base-unit conversion for chia_send;
 *   - send-form validation, address shortening, and the activity list view model.
 */

/** 1 XCH = 1e12 mojos. */
export const XCH_MOJOS_PER_UNIT = 1_000_000_000_000;

/** 1 $DIG = 1000 base units (the DIG CAT has 3 decimals). */
export const DIG_BASE_UNITS_PER_UNIT = 1000;

/** Base units per whole unit, by asset key (`'xch'` | `'dig'`). */
function perUnit(asset) {
  return asset === 'xch' ? XCH_MOJOS_PER_UNIT : DIG_BASE_UNITS_PER_UNIT;
}

/** Decimal places shown, by asset key. */
function decimals(asset) {
  return asset === 'xch' ? 12 : 3;
}

/** Trim trailing zeros (and a bare trailing dot) from a fixed-decimal string. */
function trimZeros(s) {
  if (!s.includes('.')) return s;
  return s.replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * Extract a numeric balance from a Sage `getAssetBalance` response, tolerating the several
 * casings different wallets emit. Returns a finite number, or `null` when the balance is
 * unknown/unavailable (NEVER a false `0`, so the UI can honestly show an em dash).
 *
 * @param {any} resp a number, numeric string, or object with a balance field
 * @returns {number|null}
 */
export function pickBalance(resp) {
  if (resp == null) return null;
  if (typeof resp === 'number') return Number.isFinite(resp) ? resp : null;
  if (typeof resp === 'string') {
    const n = Number(resp);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof resp !== 'object') return null;
  for (const k of ['confirmed', 'spendable', 'confirmedWalletBalance', 'confirmed_wallet_balance', 'balance']) {
    if (Object.prototype.hasOwnProperty.call(resp, k)) {
      const n = Number(resp[k]);
      if (Number.isFinite(n)) return n;
    }
  }
  if (resp.data != null && typeof resp.data === 'object') return pickBalance(resp.data);
  return null;
}

/** Format a base-unit integer for `asset` to a trimmed human string; `null` → em dash. */
function formatUnits(value, asset) {
  if (value == null) return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return trimZeros((n / perUnit(asset)).toFixed(decimals(asset)));
}

/** Format mojos as XCH (÷1e12, trailing zeros trimmed); `null` → `'—'`. */
export function formatXch(mojos) {
  return formatUnits(mojos, 'xch');
}

/** Format $DIG base units as $DIG (÷1000, 3 dp trimmed); `null` → `'—'`. */
export function formatDig(baseUnits) {
  return formatUnits(baseUnits, 'dig');
}

/**
 * Format a raw getAssetBalance response for `asset` (`'xch'`|`'dig'`) to a display string.
 * Unknown/unavailable → `'—'`.
 */
export function formatAssetBalance(resp, asset) {
  const bal = pickBalance(resp);
  if (bal == null) return '—';
  return formatUnits(bal, asset);
}

/**
 * Convert a human amount string to the asset's base unit (integer mojos / $DIG base units) for
 * `chia_send`. Rounds to the nearest base unit (no fractional mojos).
 *
 * @throws if the amount is missing, non-numeric, or not strictly positive.
 */
export function toBaseUnits(amountStr, asset) {
  const n = Number(String(amountStr == null ? '' : amountStr).trim());
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error('Enter a positive amount');
  }
  return Math.round(n * perUnit(asset));
}

/** Abbreviate a long address to `head…tail`; short/empty addresses pass through unchanged. */
export function shortenAddress(addr, head = 10, tail = 8) {
  const s = String(addr || '');
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

/**
 * Validate the send form. Returns `{ ok, errors }` where `errors` carries per-field messages
 * for `address` and/or `amount`. A valid Chia address is a bech32 `xch1…`; the amount must be
 * a strictly-positive finite number.
 *
 * @param {{address?:string, amount?:string, asset?:string}} form
 * @returns {{ok:boolean, errors:{address?:string, amount?:string}}}
 */
export function validateSendForm({ address, amount } = {}) {
  const errors = {};
  const addr = String(address || '').trim();
  if (!/^xch1[0-9a-z]{6,}$/i.test(addr)) {
    errors.address = 'Enter a valid xch1… address';
  }
  const n = Number(String(amount == null ? '' : amount).trim());
  if (!Number.isFinite(n) || n <= 0) {
    errors.amount = 'Enter a positive amount';
  }
  return { ok: Object.keys(errors).length === 0, errors };
}

/** Pull the transaction array out of the several shapes chia_getTransactions can return. */
function txList(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.transactions)) return raw.transactions;
  if (raw && Array.isArray(raw.data)) return raw.data;
  return [];
}

/** Decide incoming vs outgoing from a tx item, tolerating several field conventions. */
function txDirection(item) {
  const type = item.type != null ? String(item.type).toLowerCase() : '';
  if (type) {
    if (/out|sent|spend/.test(type)) return 'out';
    if (/in|receiv/.test(type)) return 'in';
  }
  if (Object.prototype.hasOwnProperty.call(item, 'sent')) {
    return Number(item.sent) > 0 ? 'out' : 'in';
  }
  return Number(item.amount) < 0 ? 'out' : 'in';
}

/** Decide the asset key ('xch'|'dig'|'cat') for a tx item. */
function txAsset(item, digAssetId) {
  const id = String(item.assetId || item.asset_id || item.asset || '').toLowerCase();
  if (!id) return 'xch';
  const dig = String(digAssetId || '').toLowerCase();
  if (dig && (id === dig || id.startsWith(dig) || dig.startsWith(id))) return 'dig';
  return 'cat';
}

/** Best-effort timestamp (ms) from a tx item's varied time fields. */
function txTimestamp(item) {
  const t = Number(
    item.created_at_time ?? item.createdAtTime ?? item.timestamp ?? item.time ?? 0,
  );
  if (!Number.isFinite(t) || t <= 0) return 0;
  // Heuristic: seconds → ms.
  return t < 1e12 ? t * 1000 : t;
}

/**
 * Normalise a chia_getTransactions response into a capped, newest-first activity list the UI can
 * render directly. Best-effort across Sage's tx shapes; unknown fields degrade gracefully.
 *
 * @param {any} raw the raw response (array, `{transactions}`, or `{data}`)
 * @param {{digAssetId?:string, max?:number}} [opts]
 * @returns {Array<{id:string, direction:'in'|'out', asset:string, amountLabel:string,
 *   timeLabel:string, timestamp:number, memo:string}>}
 */
export function activityViewModel(raw, { digAssetId = '', max = 100 } = {}) {
  const items = txList(raw);
  const vm = items.map((item, i) => {
    const asset = txAsset(item, digAssetId);
    const amount = Number(item.amount);
    const timestamp = txTimestamp(item);
    return {
      id: String(item.name || item.id || item.transactionId || item.tx_id || i),
      direction: txDirection(item),
      asset,
      amountLabel: Number.isFinite(amount) ? formatUnits(Math.abs(amount), asset === 'xch' ? 'xch' : 'dig') : '—',
      timeLabel: timestamp ? new Date(timestamp).toLocaleString() : '',
      timestamp,
      memo: String((Array.isArray(item.memos) && item.memos[0]) || item.memo || ''),
    };
  });
  vm.sort((a, b) => b.timestamp - a.timestamp);
  return vm.slice(0, max);
}
