/**
 * Canonical JSON serialization for the APP-SIGN auth-HMAC (dig-app `SPEC.md §5.6.3`).
 *
 * Every request frame the extension sends to dig-app over the paired `ws://127.0.0.1:9779`
 * channel carries an `auth` object whose MAC is computed over
 * `utf8(nonce) ‖ 0x00 ‖ method ‖ 0x00 ‖ canonical_json(params)`. dig-app recomputes the same MAC
 * and rejects a mismatch (`AUTH_BAD_MAC`), so this serializer MUST produce BYTE-IDENTICAL output
 * to dig-app's — it is a cross-repo wire contract, not a local convenience.
 *
 * The canonicalization is JCS (RFC 8785 — JSON Canonicalization Scheme), the standard, unambiguous
 * choice, narrowed to the value shapes that appear in `params` (objects, arrays, strings, finite
 * numbers, booleans, null):
 *
 *   - object keys are serialized in ascending UNICODE CODEPOINT order (equivalently, UTF-8 byte
 *     order) — the order Rust's default `str` Ord gives dig-app. This is DELIBERATELY NOT JS's
 *     default `Array.prototype.sort`, which orders by UTF-16 code UNITS: the two DIVERGE for any key
 *     containing a supplementary-plane character (above U+FFFF, encoded as a surrogate pair), so a
 *     JS-default sort would produce different MAC-input bytes than dig-app and fail `AUTH_BAD_MAC`.
 *     All current param keys are ASCII (where the two orders coincide), but pinning codepoint order
 *     now keeps a future non-ASCII key from silently breaking auth (dig-app SPEC §5.6.3);
 *   - NO insignificant whitespace — `{"a":1,"b":[2,3]}`, never `{ "a": 1 }`;
 *   - strings use `JSON.stringify`'s escaping (RFC 8785 and ECMAScript agree on the minimal escape
 *     set for the control/quote/backslash characters the wire carries);
 *   - numbers are integers on this wire (nonces, indices, amounts-as-integers) and serialize via
 *     `JSON.stringify`; a non-finite number is rejected rather than emitted as `null`;
 *   - `undefined`-valued object entries are OMITTED (they never reach the wire), matching how a
 *     Rust `Option::None` field is skipped during serialization.
 *
 * NOTE (open contract item, #950): dig-app SPEC §5.6.3 names `canonical_json(params)` but does not
 * pin its exact bytes. This module DEFINES it as JCS above; the dig-app side (SIGN-1/2/3) MUST
 * match. Any drift surfaces as `AUTH_BAD_MAC` on the first real frame — so it is caught loudly, not
 * silently. Keep this definition and dig-app's in lockstep.
 *
 * Pure (no chrome.* / DOM / crypto) so it is fully unit-testable and both the background SW bundle
 * and tests import it directly.
 */

/** A JSON value the canonicalizer accepts. `undefined` is only meaningful as an omitted object entry. */
export type CanonicalJsonValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue };

/**
 * Serialize `value` to its canonical JSON string (JCS — see the module doc). Deterministic and
 * byte-stable: the SAME logical value always yields the SAME string regardless of input key order,
 * so both sides of the channel compute the same MAC.
 *
 * @throws {RangeError} if a number is non-finite (`NaN`/`Infinity` have no canonical JSON form).
 */
export function canonicalJson(value: CanonicalJsonValue): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new RangeError(`canonicalJson: non-finite number is not serializable (${value})`);
      }
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'object':
      return Array.isArray(value) ? canonicalArray(value) : canonicalObject(value);
    default:
      // `undefined`/`function`/`symbol` as a TOP-LEVEL value is a programming error — object
      // entries with these values are dropped in canonicalObject before reaching here.
      throw new TypeError(`canonicalJson: value of type ${typeof value} is not serializable`);
  }
}

/** Serialize an array: elements canonicalized in order, comma-joined, no whitespace. A hole/`undefined`
 * element has no `Option::None` analogue in an array, so it serializes as `null` (JSON's rule). */
function canonicalArray(items: CanonicalJsonValue[]): string {
  return `[${items.map((item) => canonicalJson(item ?? null)).join(',')}]`;
}

/** Serialize an object: entries with a defined value only, keys ascending by Unicode codepoint. */
function canonicalObject(obj: { [key: string]: CanonicalJsonValue }): string {
  const entries = Object.keys(obj)
    .filter((key) => obj[key] !== undefined)
    .sort(compareByCodepoint)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`);
  return `{${entries.join(',')}}`;
}

/**
 * Compare two strings by Unicode codepoint (= UTF-8 byte order = Rust `str` Ord), NOT by UTF-16 code
 * unit. Spreading a string iterates its CODEPOINTS (surrogate pairs collapse to one scalar), so
 * comparing scalar-by-scalar gives codepoint order; the shorter string sorts first on a common
 * prefix. This is what keeps the MAC input byte-identical to dig-app's for a supplementary-plane key.
 */
function compareByCodepoint(a: string, b: string): number {
  const ca = [...a];
  const cb = [...b];
  const shared = Math.min(ca.length, cb.length);
  for (let i = 0; i < shared; i++) {
    const diff = (ca[i].codePointAt(0) as number) - (cb[i].codePointAt(0) as number);
    if (diff !== 0) return diff;
  }
  return ca.length - cb.length;
}
