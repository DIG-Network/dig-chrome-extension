/**
 * `.dig` DNS-label codec — the browser-side twin of dig-dns's `label.rs`
 * (modules/apps/dig-dns/src/label.rs). MUST stay byte-identical to that Rust codec: a DIG store id
 * is 32 bytes (64 lowercase hex), encoded as lowercase RFC 4648 base32 with NO padding — exactly
 * {@link DIG_LABEL_LENGTH} (52) characters — which fits a single DNS label (RFC 1035 §2.3.4 caps a
 * label at 63 chars). Base32, not base64: DNS labels are case-insensitive LDH (letters/digits/
 * hyphen), and base32's `a-z2-7` alphabet survives case-folding where base64 would not.
 *
 * Used by #172's open-by-URN dig-dns-detect branch (src/lib/open-urn.ts) to build the native
 * `http://<label>.dig/<path>` URL when the shared dig-dns availability signal (src/lib/dig-dns.ts)
 * reports the local resolver is reachable.
 */

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const STORE_ID_BYTES = 32;

/** Length in characters of the base32 (no-padding) label for a 32-byte store/root id: `ceil(32*8/5)`. */
export const DIG_LABEL_LENGTH = 52;

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/**
 * Encode raw bytes as lowercase RFC 4648 base32, no padding. The classic bit-accumulator: buffer
 * bits MSB-first as bytes arrive, emitting a 5-bit symbol every time ≥5 buffered bits are
 * available; a final partial group is left-shifted to fill the low bits with zero padding (never
 * emitted as a separate `=` pad character — matches `data_encoding::BASE32_NOPAD`).
 */
export function bytesToBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return out;
}

/**
 * Decode lowercase RFC 4648 base32 (no padding), case-insensitively, back to raw bytes. Returns
 * `null` for a character outside the `a-z2-7` alphabet, or for a NON-CANONICAL encoding whose
 * trailing (padding) bits are not all zero — `data_encoding::BASE32_NOPAD` (the Rust side) rejects
 * the same inputs, so this stays a strict mirror rather than a lenient superset.
 */
export function base32ToBytes(input: string): Uint8Array | null {
  const s = input.toLowerCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) return null;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  // Any leftover (<5) buffered bits are padding and MUST be zero in a canonical encoding.
  if (bits > 0 && (value & ((1 << bits) - 1)) !== 0) return null;
  return new Uint8Array(out);
}

/**
 * Encode a 64-lowercase(or upper)-hex DIG store/root id as its {@link DIG_LABEL_LENGTH}-char `.dig`
 * label (without the `.dig` suffix). Returns `null` for anything not exactly 64 hex characters.
 */
export function storeHexToDigLabel(hex: string): string | null {
  if (!/^[0-9a-f]{64}$/i.test(hex)) return null;
  return bytesToBase32(hexToBytes(hex.toLowerCase()));
}

/**
 * Decode a `.dig` DNS label back to its 64-lowercase-hex store/root id. Returns `null` for a label
 * that isn't exactly {@link DIG_LABEL_LENGTH} characters, contains a non-base32 character, or
 * doesn't decode to exactly {@link STORE_ID_BYTES} bytes. Case-insensitive (DNS 0x20 tolerant, so a
 * resolver's case-randomised label still decodes).
 */
export function digLabelToStoreHex(label: string): string | null {
  if (label.length !== DIG_LABEL_LENGTH) return null;
  const bytes = base32ToBytes(label);
  if (!bytes || bytes.length !== STORE_ID_BYTES) return null;
  return bytesToHex(bytes);
}
