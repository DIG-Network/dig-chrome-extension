import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// vitest mocks `*.css` imports to empty, so read the stylesheet off disk (tests run from the package
// root). This asserts against the REAL shipped palette, not a copy that could drift.
const themeCss = readFileSync(resolve(process.cwd(), 'src/styles/theme.css'), 'utf8');

/**
 * TangGangOnChia theme (#495) — WCAG-AA contrast guard. Parses the `[data-dig-theme='tanggang']`
 * palette block straight out of `theme.css` (the single source the shell repaints from) and asserts
 * every text/surface + on-accent pair the theme introduces clears the WCAG 2.2 AA ratio (§6.6), so a
 * future palette tweak that quietly drops a colour below AA fails CI. The bright citrus-orange accent
 * is why the theme flips the on-accent label to a dark ink — this test is what keeps that honest.
 */

function tanggangTokens(): Record<string, string> {
  const block = themeCss.match(/:root\[data-dig-theme='tanggang'\]\s*\{([^}]*)\}/);
  if (!block) throw new Error('tanggang palette block not found in theme.css');
  const tokens: Record<string, string> = {};
  for (const m of block[1].matchAll(/(--dig-[\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) {
    tokens[m[1]] = m[2];
  }
  return tokens;
}

function relLuminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const chan = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * chan[0] + 0.7152 * chan[1] + 0.0722 * chan[2];
}

function contrast(a: string, b: string): number {
  const la = relLuminance(a);
  const lb = relLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

describe('TangGangOnChia theme (#495) — palette + WCAG-AA contrast', () => {
  const t = tanggangTokens();

  it('defines the full --dig-* token set (orange primary + green accent + dark on-accent)', () => {
    expect(t['--dig-accent']).toBe('#ff9000'); // citrus orange (tanggangchia.com nav / wordmark)
    expect(t['--dig-accent-2']).toBe('#57c528'); // sprout green ("chia" wordmark / 🌱)
    expect(t['--dig-on-accent']).toBe('#2b1500'); // dark ink so a label on the bright accent stays AA
    for (const key of ['--dig-bg', '--dig-text', '--dig-text-dim', '--dig-text-faint', '--dig-accent-ink', '--dig-good']) {
      expect(t[key], `${key} present`).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('body text clears AA (>=4.5:1) against the ground', () => {
    expect(contrast(t['--dig-text'], t['--dig-bg'])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t['--dig-text-dim'], t['--dig-bg'])).toBeGreaterThanOrEqual(4.5);
  });

  it('faint text + accent-ink + status green clear AA (>=4.5:1) against the ground', () => {
    expect(contrast(t['--dig-text-faint'], t['--dig-bg'])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t['--dig-accent-ink'], t['--dig-bg'])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t['--dig-good'], t['--dig-bg'])).toBeGreaterThanOrEqual(4.5);
  });

  it('the primary-button label (on-accent) clears AA against BOTH gradient stops (orange + green)', () => {
    // The primary button/brand gradient runs --dig-accent (orange) → --dig-accent-2 (green); the
    // dark on-accent ink must stay readable across the whole sweep, not just one end.
    expect(contrast(t['--dig-on-accent'], t['--dig-accent'])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t['--dig-on-accent'], t['--dig-accent-2'])).toBeGreaterThanOrEqual(4.5);
  });

  it('raised/elevated surfaces keep body text AA (>=4.5:1)', () => {
    expect(contrast(t['--dig-text'], t['--dig-bg-raised'])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t['--dig-text'], t['--dig-bg-elev'])).toBeGreaterThanOrEqual(4.5);
  });
});
