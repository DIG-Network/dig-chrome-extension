/**
 * Tests for the `.dig` DNS-label codec (src/lib/dig-dns-host.ts) — the browser-side twin of
 * dig-dns's `label.rs` (modules/apps/dig-dns/src/label.rs). Fixtures are copied verbatim from that
 * Rust module's own test vectors so the two implementations are PROVEN byte-identical, not just
 * independently self-consistent (#172).
 */
import { describe, it, expect } from 'vitest';
import {
  DIG_LABEL_LENGTH,
  storeHexToDigLabel,
  digLabelToStoreHex,
  bytesToBase32,
  base32ToBytes,
} from '@/lib/dig-dns-host';

const ZERO_HEX = '0'.repeat(64);
// base32 of 32 zero bytes = 52 'a's (dig-dns label.rs `ZERO_LABEL`, lowercased).
const ZERO_LABEL = 'a'.repeat(52);
const SAMPLE_HEX = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('DIG_LABEL_LENGTH', () => {
  it('is 52 — ceil(32 bytes * 8 bits / 5 bits-per-base32-char)', () => {
    expect(DIG_LABEL_LENGTH).toBe(52);
  });
});

describe('storeHexToDigLabel', () => {
  it('encodes the all-zero store id to 52 lowercase "a" characters (dig-dns parity fixture)', () => {
    const label = storeHexToDigLabel(ZERO_HEX);
    expect(label).toBe(ZERO_LABEL);
    expect(label).toHaveLength(DIG_LABEL_LENGTH);
  });

  it('encodes a mixed hex id to a 52-char lowercase a-z2-7 label', () => {
    const label = storeHexToDigLabel(SAMPLE_HEX);
    expect(label).not.toBeNull();
    expect(label).toHaveLength(DIG_LABEL_LENGTH);
    expect(label).toMatch(/^[a-z2-7]{52}$/);
  });

  it('is case-insensitive on the hex input', () => {
    expect(storeHexToDigLabel(SAMPLE_HEX.toUpperCase())).toBe(storeHexToDigLabel(SAMPLE_HEX));
  });

  it('rejects anything that is not exactly 64 hex characters', () => {
    expect(storeHexToDigLabel('abc')).toBeNull();
    expect(storeHexToDigLabel('g'.repeat(64))).toBeNull();
    expect(storeHexToDigLabel(SAMPLE_HEX.slice(0, 63))).toBeNull();
    expect(storeHexToDigLabel('')).toBeNull();
  });
});

describe('digLabelToStoreHex', () => {
  it('decodes the all-"a" label back to the all-zero hex id', () => {
    expect(digLabelToStoreHex(ZERO_LABEL)).toBe(ZERO_HEX);
  });

  it('round-trips a sample id through encode -> decode', () => {
    const label = storeHexToDigLabel(SAMPLE_HEX);
    expect(label).not.toBeNull();
    expect(digLabelToStoreHex(label as string)).toBe(SAMPLE_HEX);
  });

  it('is case-insensitive (DNS 0x20 tolerant)', () => {
    const label = storeHexToDigLabel(SAMPLE_HEX) as string;
    const mixed = label
      .split('')
      .map((c, i) => (i % 2 === 0 ? c.toUpperCase() : c))
      .join('');
    expect(digLabelToStoreHex(label.toUpperCase())).toBe(SAMPLE_HEX);
    expect(digLabelToStoreHex(mixed)).toBe(SAMPLE_HEX);
  });

  it('rejects a label of the wrong length', () => {
    expect(digLabelToStoreHex('a'.repeat(51))).toBeNull();
    expect(digLabelToStoreHex('a'.repeat(53))).toBeNull();
    expect(digLabelToStoreHex('')).toBeNull();
  });

  it('rejects characters outside the base32 a-z2-7 alphabet', () => {
    expect(digLabelToStoreHex(`${'a'.repeat(51)}0`)).toBeNull(); // '0','1','8','9' not in alphabet
    expect(digLabelToStoreHex(`${'a'.repeat(51)}-`)).toBeNull();
  });
});

describe('bytesToBase32 / base32ToBytes (RFC 4648, no padding)', () => {
  it('round-trips arbitrary byte sequences', () => {
    const bytes = new Uint8Array(32);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i;
    const encoded = bytesToBase32(bytes);
    expect(encoded).toHaveLength(52);
    expect(base32ToBytes(encoded)).toEqual(bytes);
  });

  it('encodes all-0xff bytes to a 52-char lowercase label', () => {
    const bytes = new Uint8Array(32).fill(0xff);
    const encoded = bytesToBase32(bytes);
    expect(encoded).toHaveLength(52);
    expect(encoded).toMatch(/^[a-z2-7]+$/);
  });

  it('rejects a base32 string with non-zero padding bits (non-canonical encoding)', () => {
    // A label whose trailing bits are non-zero cannot have been produced by a canonical no-pad
    // encoder — data_encoding::BASE32_NOPAD (the Rust side) rejects it too.
    expect(base32ToBytes(`${'a'.repeat(51)}b`)).toBeNull();
  });
});
