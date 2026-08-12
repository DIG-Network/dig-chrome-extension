/**
 * URN parse conformance — the extension is run against the SHARED table, not against a local
 * restatement of it.
 *
 * The parsed `resourceKey` and `salt` feed retrieval-key and decryption-key derivation
 * (`src/background/index.ts` → `dig.retrievalKey` / `dig.deriveKey`), so two implementations that
 * parse one URN differently derive different keys and read different bytes. Agreement therefore has
 * to be RUN, never asserted in a comment — a prose claim of byte-identity is exactly what let these
 * parsers drift apart (super-repo #2725).
 *
 * The table is READ FROM THE PACKAGE (`@dignetwork/dig-sdk/conformance/urn-parse.json`, a real
 * subpath export) and is deliberately NOT copied into this repo: a copy is a snapshot that goes
 * stale silently, which is the same drift wearing a different hat. Bumping the devDependency is
 * what adopts a new revision of the contract, and CI is where the disagreement surfaces.
 *
 * Field mapping between the two shapes (the ONLY licensed difference):
 *   • the table's `root`      ⇄ this parser's `roothash`
 *   • the table's `{ invalid: true }` ⇄ this parser's `null` return
 *
 * The extension's parser accepts a deliberate SUPERSET of inputs (a `chia://` prefix, leading
 * slashes, an optional `urn:dig:` prefix, the bare `{storeId}[:{root}][/{key}]` form, an empty
 * resource key). That superset is not a divergence and is not exercised here — every table row is
 * spelled in the canonical `urn:dig:chia:` form, so the table constrains the shared behaviour
 * without constraining the superset.
 */
import { describe, it, expect } from 'vitest';
import table from '@dignetwork/dig-sdk/conformance/urn-parse.json';
import { parseURN } from './dig-urn';

interface ConformanceCase {
  name: string;
  urn: string;
  expect:
    | { invalid: true }
    | { storeId: string; root: string | null; resourceKey: string; salt: string | null };
}

const cases = (table as { version: number; cases: ConformanceCase[] }).cases;

describe('dig-sdk URN conformance table', () => {
  it('is loaded from the package and is non-empty', () => {
    // Guards the runner itself: a resolution change that yielded an empty table would otherwise
    // report a vacuous all-green.
    expect(Array.isArray(cases)).toBe(true);
    expect(cases.length).toBeGreaterThan(20);
  });

  for (const c of cases) {
    it(c.name, () => {
      const actual = parseURN(c.urn);
      if ('invalid' in c.expect) {
        expect(actual).toBeNull();
        return;
      }
      expect(actual).not.toBeNull();
      expect({
        storeId: actual!.storeId,
        root: actual!.roothash,
        resourceKey: actual!.resourceKey,
        salt: actual!.salt,
      }).toEqual({
        storeId: c.expect.storeId,
        root: c.expect.root,
        resourceKey: c.expect.resourceKey,
        salt: c.expect.salt,
      });
    });
  }
});
