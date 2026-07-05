import { describe, it, expect } from 'vitest';
import {
  generateMnemonic,
  isValidMnemonic,
  mnemonicToEntropy,
  entropyToMnemonic,
  mnemonicToSeed,
  mnemonicWords,
  normalizeMnemonic,
  ENTROPY_BYTES,
  WORD_COUNT,
} from './bip39';

// The canonical BIP-39 all-zeros-entropy vector (public test data, no funds).
const ZEROS = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art';
// Published BIP-39 seed for the all-zeros 24-word mnemonic with an empty passphrase.
const ZEROS_SEED_HEX =
  '408b285c123836004f4b8842c89324c1f01382450c0d439af345ba7fc49acf705489c6fc77dbd4e3dc1dd8cc6bc9f043db8ada1e243c4a0eafb290d399480840';

const toHex = (u: Uint8Array): string => Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');

describe('bip39', () => {
  it('generates a fresh, valid 24-word mnemonic each call', () => {
    const a = generateMnemonic();
    const b = generateMnemonic();
    expect(a.split(' ')).toHaveLength(WORD_COUNT);
    expect(isValidMnemonic(a)).toBe(true);
    expect(a).not.toBe(b); // 256 bits of entropy — collisions are impossible in practice
  });

  it('round-trips entropy ⇄ mnemonic (all-zeros → abandon…art)', () => {
    const zeros = new Uint8Array(ENTROPY_BYTES);
    expect(entropyToMnemonic(zeros)).toBe(ZEROS);
    expect(toHex(mnemonicToEntropy(ZEROS))).toBe('00'.repeat(ENTROPY_BYTES));
  });

  it('round-trips generated entropy exactly (reveal-phrase path)', () => {
    const m = generateMnemonic();
    const e = mnemonicToEntropy(m);
    expect(e).toHaveLength(ENTROPY_BYTES);
    expect(entropyToMnemonic(e)).toBe(m);
  });

  it('derives the published BIP-39 seed with an empty passphrase (Chia convention)', async () => {
    const seed = await mnemonicToSeed(ZEROS);
    expect(seed).toHaveLength(64);
    expect(toHex(seed)).toBe(ZEROS_SEED_HEX);
  });

  it('validates word-list membership and checksum', () => {
    expect(isValidMnemonic(ZEROS)).toBe(true);
    expect(isValidMnemonic('not a valid mnemonic phrase at all')).toBe(false);
    // A valid-word phrase with a wrong checksum must fail.
    const badChecksum = ZEROS.replace(/art$/, 'abandon');
    expect(isValidMnemonic(badChecksum)).toBe(false);
    expect(isValidMnemonic('')).toBe(false);
  });

  it('normalizes case and whitespace before validating', () => {
    const messy = `  ABANDON   ${ZEROS.split(' ').slice(1).join('  ')}  `;
    expect(normalizeMnemonic(messy)).toBe(ZEROS);
    expect(isValidMnemonic(messy)).toBe(true);
    expect(toHex(mnemonicToEntropy(messy))).toBe('00'.repeat(ENTROPY_BYTES));
  });

  it('splits a mnemonic into its words for the confirm-a-word step', () => {
    expect(mnemonicWords(ZEROS)).toHaveLength(WORD_COUNT);
    expect(mnemonicWords(ZEROS)[WORD_COUNT - 1]).toBe('art');
  });

  it('rejects wrong-length entropy on encode', () => {
    expect(() => entropyToMnemonic(new Uint8Array(16))).toThrow(/32 bytes/);
  });
});
