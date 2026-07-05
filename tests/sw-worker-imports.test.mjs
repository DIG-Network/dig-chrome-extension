/**
 * Regression: the module service worker's runtime module graph must be complete in dist/.
 *
 * background.js is (currently) a plain-copied ES-module service worker that statically imports a
 * set of sibling `./X.mjs` modules at runtime. Each such module MUST also be emitted into dist/
 * (listed in build.js EXTENSION_FILES) or the SW fails to load its module graph and never
 * registers — silently disabling chia:// resolution + the wallet, with no CI signal (there is no
 * browser SW-registration test). This exact drift shipped once: background.js imported
 * `./custody-session.mjs` while build.js omitted it from the copy list.
 *
 * This test pins the invariant at the source level: every `from './X.mjs'` static import in
 * background.js is present in build.js's EXTENSION_FILES copy list. (When background.js is later
 * converted to an esbuild-bundled entry — issue #68 — its imports get inlined and this invariant
 * moves to the bundler; update this test at that point.)
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(ROOT, f), 'utf8');

test('every ./X.mjs statically imported by background.js is in build.js EXTENSION_FILES', () => {
  const bg = read('background.js');
  const buildJs = read('build.js');

  // Collect every relative sibling `.mjs` specifier imported by the SW (static `from './X.mjs'`).
  const imported = new Set();
  for (const m of bg.matchAll(/from\s+['"]\.\/([a-z0-9-]+\.mjs)['"]/gi)) {
    imported.add(m[1]);
  }
  assert.ok(imported.size > 0, 'expected background.js to import at least one ./X.mjs module');

  const missing = [...imported].filter((f) => !buildJs.includes(`'${f}'`));
  assert.deepEqual(
    missing,
    [],
    `background.js imports these ./X.mjs modules that build.js never copies to dist/ (SW would ` +
      `fail to load): ${missing.join(', ')}`
  );
});
