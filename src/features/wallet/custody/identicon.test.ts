import { describe, it, expect } from 'vitest';
import { identiconFor, IDENTICON_COLS, IDENTICON_ROWS } from '@/features/wallet/custody/identicon';

/**
 * Pure deterministic identicon spec (#176 — wallet switcher redesign). The generator is keyed by
 * whatever PUBLIC seed the caller passes (the wallet's opaque registry id, or its cached preview
 * address) — this module knows nothing about keys/records at all, so it structurally cannot leak
 * private key material (the security bar in #176: "never the private key").
 */
describe('identiconFor (#176)', () => {
  it('is deterministic — the same seed always produces the same spec', () => {
    const a = identiconFor('wallet-id-1');
    const b = identiconFor('wallet-id-1');
    expect(b).toEqual(a);
  });

  it('different seeds produce different specs (no collision for these two)', () => {
    const a = identiconFor('wallet-id-1');
    const b = identiconFor('wallet-id-2');
    expect(a).not.toEqual(b);
  });

  it('hue is a stable value in [0, 360)', () => {
    for (const seed of ['a', 'b', 'xch1aaa', 'wallet-1', '']) {
      const { hue } = identiconFor(seed);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
      expect(Number.isInteger(hue)).toBe(true);
    }
  });

  it('cells has exactly ROWS × COLS booleans', () => {
    const { cells } = identiconFor('any-seed');
    expect(cells).toHaveLength(IDENTICON_ROWS * IDENTICON_COLS);
    for (const c of cells) expect(typeof c).toBe('boolean');
  });

  it('never throws on empty/undefined-like seeds — falls back to a stable default pattern', () => {
    expect(() => identiconFor('')).not.toThrow();
    expect(identiconFor('')).toEqual(identiconFor(''));
  });

  it('two real wallet ids produce visibly different patterns (not all-same/all-empty)', () => {
    const specs = ['w1', 'w2', 'w3', 'w4'].map(identiconFor);
    // Not every spec collapses to the same hue (a degenerate hash would do this).
    const hues = new Set(specs.map((s) => s.hue));
    expect(hues.size).toBeGreaterThan(1);
  });
});
