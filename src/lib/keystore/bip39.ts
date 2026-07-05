/**
 * BIP-39 mnemonic layer for the self-custody wallet — a thin, typed wrapper over the audited,
 * dependency-free `@scure/bip39` (paulmillr). This is the FIRST link of the custody chain:
 *
 *   entropy (32 B) ⇄ 24-word English mnemonic → seed (empty passphrase, Chia convention)
 *
 * We store the 256-bit ENTROPY (not the derived seed/scalar) so "reveal recovery phrase" is a
 * byte-exact regeneration of the same 24 words (§5.2). The mnemonic → seed step uses an EMPTY
 * passphrase — this is the Chia convention (NOT configurable), matching
 * `dig-l1-wallet::keystore::mnemonic::derive_master_key_from_mnemonic` (`mnemonic.to_seed("")`),
 * so a given seed reproduces the exact same wallet as dig-l1-wallet / Sage.
 *
 * Pure module (no chrome.* / DOM / wasm) so it runs identically in the offscreen document and the
 * Vitest harness. Every function here is deterministic given its inputs except `generateMnemonic`,
 * which draws fresh CSPRNG entropy.
 */

import {
  generateMnemonic as scureGenerate,
  validateMnemonic as scureValidate,
  mnemonicToEntropy as scureToEntropy,
  entropyToMnemonic as scureToMnemonic,
  mnemonicToSeed as scureToSeed,
} from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';

/** Chia wallets use 256-bit entropy → a 24-word mnemonic (the official wallet's size). */
export const ENTROPY_BITS = 256;
/** Entropy length in bytes (256 bits). */
export const ENTROPY_BYTES = 32;
/** Word count for a Chia-standard 24-word recovery phrase. */
export const WORD_COUNT = 24;

/**
 * Generate a fresh 24-word English mnemonic from 256 bits of CSPRNG entropy.
 * `@scure/bip39` sources entropy from the platform `crypto` — no custom RNG.
 */
export function generateMnemonic(): string {
  return scureGenerate(wordlist, ENTROPY_BITS);
}

/**
 * Validate a mnemonic's word-list membership AND checksum (mirrors dig-l1-wallet's
 * `validate_mnemonic`). Normalizes whitespace/case before checking. Returns `false` (never throws)
 * so callers can branch cleanly; the onboarding import flow maps `false` to the `InvalidMnemonic`
 * copy (§6).
 */
export function isValidMnemonic(mnemonic: string): boolean {
  try {
    return scureValidate(normalizeMnemonic(mnemonic), wordlist);
  } catch {
    return false;
  }
}

/**
 * Recover the raw entropy behind a mnemonic (the value we persist, encrypted). Throws if the
 * mnemonic is invalid (bad word or checksum) — callers that accept user input should gate on
 * {@link isValidMnemonic} first for a friendly error.
 */
export function mnemonicToEntropy(mnemonic: string): Uint8Array {
  return scureToEntropy(normalizeMnemonic(mnemonic), wordlist);
}

/**
 * Regenerate the exact 24-word mnemonic from stored entropy — the "reveal recovery phrase" path.
 * Byte-exact inverse of {@link mnemonicToEntropy}. Rejects a wrong-length entropy buffer.
 */
export function entropyToMnemonic(entropy: Uint8Array): string {
  if (entropy.length !== ENTROPY_BYTES) {
    throw new Error(`entropy must be ${ENTROPY_BYTES} bytes (got ${entropy.length})`);
  }
  return scureToMnemonic(entropy, wordlist);
}

/**
 * Derive the 64-byte BIP-39 seed from a mnemonic with the Chia-mandated EMPTY passphrase. Feeds
 * `SecretKey.fromSeed` in the derivation layer. Matches `mnemonic.to_seed("")` byte-for-byte
 * (verified against the published BIP-39 all-zeros test vector in the golden parity test).
 */
export async function mnemonicToSeed(mnemonic: string): Promise<Uint8Array> {
  return scureToSeed(normalizeMnemonic(mnemonic), '');
}

/** The individual words of a mnemonic (for the onboarding reveal + confirm-a-word steps). */
export function mnemonicWords(mnemonic: string): string[] {
  return normalizeMnemonic(mnemonic).split(' ');
}

/** Lower-case + collapse internal whitespace so pasted phrases validate leniently. */
export function normalizeMnemonic(mnemonic: string): string {
  return mnemonic.trim().toLowerCase().split(/\s+/).join(' ');
}
