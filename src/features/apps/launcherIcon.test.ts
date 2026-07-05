import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Regression guard for the launcher / Home dApp icons (#68 fold): they must read as
 * phone-home-screen icons — a squircle (`border-radius`) + a soft drop shadow ONLY, with NO
 * border / outline / ring. `.dig-app-icon` is the shared icon frame used by BOTH the Apps grid and
 * the Home launcher widget, so a stray `inset` box-shadow ring or a `border` on its resting rule
 * reintroduces the boxed look this fix removed. The keyboard `:focus-visible` outline is a separate,
 * required a11y indicator and is intentionally NOT covered here.
 */
const themeCss = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../styles/theme.css'),
  'utf8',
);

/** The body of a top-level `<selector> { … }` rule (line-anchored so descendant / state / media-nested rules are excluded). */
function restingRule(selector: string): string {
  const m = themeCss.match(new RegExp(`\\n${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`));
  if (!m) throw new Error(`${selector} rule not found in theme.css`);
  return m[1];
}
const restingIconRule = (): string => restingRule('.dig-app-icon');

describe('launcher icon styling (.dig-app-icon)', () => {
  it('keeps the squircle + soft shadow', () => {
    const body = restingIconRule();
    expect(body).toMatch(/border-radius:/);
    expect(body).toMatch(/box-shadow:/);
  });

  it('has NO border / outline / inset ring (phone-icon look)', () => {
    const body = restingIconRule();
    expect(body).not.toMatch(/\binset\b/); // no inset box-shadow ring
    expect(body).not.toMatch(/\bborder\s*:/); // no border
    expect(body).not.toMatch(/\boutline\s*:/); // no resting outline
  });
});

describe('launcher tile styling (.dig-app-tile)', () => {
  it('resets the <button> chrome so no border/box shows at rest', () => {
    const body = restingRule('.dig-app-tile');
    expect(body).toMatch(/border:\s*none/); // UA button border explicitly removed
    expect(body).toMatch(/background:\s*none/); // no grey button face
    // No visible drawn border (a 1px/2px solid rule) that would re-box the tile.
    expect(body).not.toMatch(/border:\s*\d/);
  });
});
