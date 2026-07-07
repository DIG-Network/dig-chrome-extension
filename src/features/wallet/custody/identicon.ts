/**
 * Deterministic per-wallet identicon (#176 — wallet switcher redesign). A small geometric avatar
 * so wallets are visually distinguishable at a glance in the switcher's list — keyed by PUBLIC data
 * ONLY (never key material): the caller passes either the wallet's cached preview address (itself a
 * public commitment, safe to share to receive funds) or, when no address is cached yet, the
 * wallet's opaque registry id (a random uuid already sent to the UI unencrypted, see {@link
 * WalletMeta} in `@/lib/wallet-registry`). This module never sees a mnemonic, a private key, or a
 * decrypted record — it is pure string-hashing, so it structurally cannot leak one.
 *
 * The algorithm is a plain synchronous hash (no crypto dependency needed or wanted — this is a
 * decorative visual, not a security primitive): FNV-1a-style mixing over the seed produces a hue
 * plus a half-grid of on/off cells, which the presentational {@link WalletIdenticon} component
 * mirrors left-right into a symmetric 5-row pattern (a classic identicon look) and renders as SVG.
 */

/** Grid dimensions of the generated pattern (rows × half-columns; the renderer mirrors columns). */
export const IDENTICON_ROWS = 5;
export const IDENTICON_COLS = 3;

/** One wallet's deterministic identicon data — a hue plus an on/off half-grid. */
export interface IdenticonSpec {
  /** Integer hue in [0, 360) for the pattern's foreground/background colors. */
  hue: number;
  /** `IDENTICON_ROWS * IDENTICON_COLS` booleans, row-major, left half only (the renderer mirrors it). */
  cells: boolean[];
}

/** A tiny, fast, non-cryptographic 32-bit string hash (FNV-1a). Deterministic across platforms. */
function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Derive an identicon spec from a public seed string. Same seed → same spec, always. */
export function identiconFor(seed: string): IdenticonSpec {
  const base = fnv1a(seed || 'dig-wallet');
  const hue = base % 360;
  const cells: boolean[] = [];
  for (let i = 0; i < IDENTICON_ROWS * IDENTICON_COLS; i++) {
    // Re-hash the seed with the cell index folded in so cells aren't just adjacent bits of one
    // hash (which would look visibly striped) — a cheap way to decorrelate neighboring cells.
    const cellHash = fnv1a(`${seed}:${i}:${base}`);
    cells.push((cellHash & 1) === 1);
  }
  return { hue, cells };
}
