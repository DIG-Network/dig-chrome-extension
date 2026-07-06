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
 *   - send-form validation, address shortening, and the activity list view model
 *     (each item carrying a SpaceScan coin link + fee + confirmed/pending status).
 */

import { spaceScanCoinUrl } from './links';

/** 1 XCH = 1e12 mojos. */
export const XCH_MOJOS_PER_UNIT = 1_000_000_000_000;

/** 1 $DIG = 1000 base units (the DIG CAT has 3 decimals). */
export const DIG_BASE_UNITS_PER_UNIT = 1000;

/**
 * Decimal places for an asset — accepts either a decimals NUMBER (arbitrary CAT / fee) or an
 * asset KEY (`'xch'` → 12, anything else → 3, the Chia CAT convention). This lets the same
 * formatters serve XCH, $DIG, and any tracked CAT.
 */
function decimals(assetOrDecimals: number | string): number {
  if (typeof assetOrDecimals === 'number') return assetOrDecimals;
  return assetOrDecimals === 'xch' ? 12 : 3;
}

/** Base units per whole unit for an asset key or decimals number. */
function perUnit(assetOrDecimals: number | string): number {
  return 10 ** decimals(assetOrDecimals);
}

/** Trim trailing zeros (and a bare trailing dot) from a fixed-decimal string. */
function trimZeros(s: string): string {
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
export function pickBalance(resp: unknown): number | null {
  if (resp == null) return null;
  if (typeof resp === 'number') return Number.isFinite(resp) ? resp : null;
  if (typeof resp === 'string') {
    const n = Number(resp);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof resp !== 'object') return null;
  const o = resp as Record<string, unknown>;
  for (const k of ['confirmed', 'spendable', 'confirmedWalletBalance', 'confirmed_wallet_balance', 'balance']) {
    if (Object.prototype.hasOwnProperty.call(o, k)) {
      const n = Number(o[k]);
      if (Number.isFinite(n)) return n;
    }
  }
  if (o.data != null && typeof o.data === 'object') return pickBalance(o.data);
  return null;
}

/**
 * Format a base-unit integer to a trimmed human string at `decimalsOrAsset` places (a decimals
 * NUMBER, or an asset KEY — `'xch'`→12, else 3). `null`/non-finite → em dash (never a false `0`).
 * @param {number|string|null} value base units
 * @param {number|string} decimalsOrAsset decimals count or asset key
 * @returns {string}
 */
export function formatBaseUnits(value: number | string | null, decimalsOrAsset: number | string): string {
  if (value == null) return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return trimZeros((n / perUnit(decimalsOrAsset)).toFixed(decimals(decimalsOrAsset)));
}

/** Format mojos as XCH (÷1e12, trailing zeros trimmed); `null` → `'—'`. */
export function formatXch(mojos: number | string | null): string {
  return formatBaseUnits(mojos, 'xch');
}

/** Format $DIG base units as $DIG (÷1000, 3 dp trimmed); `null` → `'—'`. */
export function formatDig(baseUnits: number | string | null): string {
  return formatBaseUnits(baseUnits, 'dig');
}

/**
 * Format a raw getAssetBalance response for an asset key (`'xch'`|`'dig'`|`'cat'`) or a decimals
 * number to a display string. Unknown/unavailable → `'—'`.
 */
export function formatAssetBalance(resp: unknown, decimalsOrAsset: number | string): string {
  const bal = pickBalance(resp);
  if (bal == null) return '—';
  return formatBaseUnits(bal, decimalsOrAsset);
}

/**
 * Convert a human amount string to base units (integer mojos / CAT base units) for `chia_send`
 * / offer legs. `decimalsOrAsset` is a decimals NUMBER or an asset KEY. Rounds to the nearest
 * base unit (no fractional mojos).
 *
 * @throws if the amount is missing, non-numeric, or not strictly positive.
 */
export function toBaseUnits(amountStr: string | number | null, decimalsOrAsset: number | string): number {
  const n = Number(String(amountStr == null ? '' : amountStr).trim());
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error('Enter a positive amount');
  }
  return Math.round(n * perUnit(decimalsOrAsset));
}

/** Abbreviate a long address to `head…tail`; short/empty addresses pass through unchanged. */
export function shortenAddress(addr: string | null, head = 10, tail = 8): string {
  const s = String(addr || '');
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

/**
 * True if `value` is a well-formed Chia payment address — a bech32(m) `xch1…` string. This is a
 * FORMAT gate (prefix + charset + minimum length), not a checksum verify; the offscreen vault does
 * the authoritative `Address.decode` when it builds the spend. It is the single source of truth for
 * "is this an xch1 address" shared by the Send form and the address book (#88), so the two never
 * disagree about which strings are valid recipients.
 */
export function isChiaAddress(value: unknown): boolean {
  return /^xch1[0-9a-z]{6,}$/i.test(String(value == null ? '' : value).trim());
}

/**
 * Validate the send form. Returns `{ ok, errors }` where `errors` carries per-field messages
 * for `address`, `amount`, and/or `fee`. A valid Chia address is a bech32 `xch1…`; the amount
 * must be a strictly-positive finite number. The fee is OPTIONAL — blank/absent is treated as
 * 0 — but when present it must be a non-negative finite number (an XCH fee, always in XCH).
 *
 * @param {{address?:string, amount?:string, asset?:string, fee?:string}} form
 * @returns {{ok:boolean, errors:{address?:string, amount?:string, fee?:string}}}
 */
export function validateSendForm({
  address,
  amount,
  fee,
}: { address?: string; amount?: string; asset?: string; fee?: string } = {}): {
  ok: boolean;
  errors: { address?: string; amount?: string; fee?: string };
} {
  const errors: { address?: string; amount?: string; fee?: string } = {};
  if (!isChiaAddress(address)) {
    errors.address = 'Enter a valid xch1… address';
  }
  const n = Number(String(amount == null ? '' : amount).trim());
  if (!Number.isFinite(n) || n <= 0) {
    errors.amount = 'Enter a positive amount';
  }
  const feeStr = String(fee == null ? '' : fee).trim();
  if (feeStr !== '') {
    const f = Number(feeStr);
    if (!Number.isFinite(f) || f < 0) {
      errors.fee = 'Fee must be zero or more';
    }
  }
  return { ok: Object.keys(errors).length === 0, errors };
}

/** Pull the transaction array out of the several shapes chia_getTransactions can return. */
function txList(raw: unknown): Record<string, unknown>[] {
  if (Array.isArray(raw)) return raw as Record<string, unknown>[];
  const r = raw as { transactions?: unknown; data?: unknown } | null;
  if (r && Array.isArray(r.transactions)) return r.transactions as Record<string, unknown>[];
  if (r && Array.isArray(r.data)) return r.data as Record<string, unknown>[];
  return [];
}

/** Decide incoming vs outgoing from a tx item, tolerating several field conventions. */
function txDirection(item: Record<string, unknown>): 'in' | 'out' {
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
function txAsset(item: Record<string, unknown>, digAssetId: string): 'xch' | 'dig' | 'cat' {
  const id = String(item.assetId || item.asset_id || item.asset || '').toLowerCase();
  if (!id) return 'xch';
  const dig = String(digAssetId || '').toLowerCase();
  if (dig && (id === dig || id.startsWith(dig) || dig.startsWith(id))) return 'dig';
  return 'cat';
}

/** Best-effort timestamp (ms) from a tx item's varied time fields. */
function txTimestamp(item: Record<string, unknown>): number {
  const t = Number(
    item.created_at_time ?? item.createdAtTime ?? item.timestamp ?? item.time ?? 0,
  );
  if (!Number.isFinite(t) || t <= 0) return 0;
  // Heuristic: seconds → ms.
  return t < 1e12 ? t * 1000 : t;
}

/** The durable coin/tx id from a tx item's varied id fields, or `null` if none is present. */
function txRawId(item: Record<string, unknown>): string | null {
  const id = item.name || item.id || item.transactionId || item.tx_id || item.coinId || item.coin_id;
  return id ? String(id) : null;
}

/** True if a tx item reports itself confirmed (tolerating several conventions). */
function txConfirmed(item: Record<string, unknown>): boolean {
  if (item.confirmed === true) return true;
  if (item.confirmed === false) return false;
  const h = Number(item.confirmedAtHeight ?? item.confirmed_at_height ?? item.confirmed_height ?? 0);
  return Number.isFinite(h) && h > 0;
}

/**
 * Normalise a chia_getTransactions response into a capped, newest-first activity list the UI can
 * render directly. Best-effort across Sage's tx shapes; unknown fields degrade gracefully. Each
 * item carries a SpaceScan coin link, an XCH fee label, and a confirmed/pending status so the
 * Activity view can show full detail (parity with the native DIG Browser wallet's history).
 *
 * @param {any} raw the raw response (array, `{transactions}`, or `{data}`)
 * @param {{digAssetId?:string, max?:number}} [opts]
 * @returns {Array<{id:string, rawId:string|null, direction:'in'|'out', asset:string,
 *   amountLabel:string, timeLabel:string, timestamp:number, memo:string, feeLabel:string,
 *   statusLabel:string, confirmed:boolean, spaceScanUrl:string|null}>}
 */
/** One normalised activity row the Activity view renders directly. */
export interface ActivityItem {
  id: string;
  rawId: string | null;
  direction: 'in' | 'out';
  asset: string;
  amountLabel: string;
  timeLabel: string;
  timestamp: number;
  memo: string;
  feeLabel: string;
  statusLabel: string;
  confirmed: boolean;
  spaceScanUrl: string | null;
}

export function activityViewModel(
  raw: unknown,
  { digAssetId = '', max = 100 }: { digAssetId?: string; max?: number } = {},
): ActivityItem[] {
  const items = txList(raw);
  const vm = items.map((item, i) => {
    const asset = txAsset(item, digAssetId);
    const amount = Number(item.amount);
    const timestamp = txTimestamp(item);
    const rawId = txRawId(item);
    const fee = Number(item.fee);
    const confirmed = txConfirmed(item);
    return {
      id: rawId || String(i),
      rawId,
      direction: txDirection(item),
      asset,
      amountLabel: Number.isFinite(amount) ? formatBaseUnits(Math.abs(amount), asset === 'xch' ? 'xch' : 'dig') : '—',
      timeLabel: timestamp ? new Date(timestamp).toLocaleString() : '',
      timestamp,
      memo: String((Array.isArray(item.memos) && item.memos[0]) || item.memo || ''),
      feeLabel: Number.isFinite(fee) && fee > 0 ? `${formatXch(fee)} XCH` : '',
      confirmed,
      statusLabel: confirmed ? 'Confirmed' : 'Pending',
      spaceScanUrl: spaceScanCoinUrl(rawId),
    };
  });
  vm.sort((a, b) => b.timestamp - a.timestamp);
  return vm.slice(0, max);
}
