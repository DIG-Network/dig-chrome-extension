/**
 * Wallet view-model — the popup wallet's PURE presentation + input logic (no DOM / chrome.*).
 *
 * The self-custody wallet turns on-chain values into display and user input into on-chain amounts;
 * this module owns that pure logic so the renderer stays thin glue and every branch is unit-tested:
 *   - unit conversion: base units ↔ whole units at an asset's decimals (XCH = 12, CATs incl. $DIG = 3);
 *   - human-amount → base-unit conversion for spends / offer legs;
 *   - send-form validation, `xch1…` address format-gating, and address shortening.
 */

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
