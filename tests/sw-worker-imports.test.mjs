/**
 * Regression: the module service worker's runtime module graph must be complete + correctly wired.
 *
 * As of #68 the SW is NO LONGER a plain-copied root `background.js`: it is a strict entry at
 * src/background/index.ts that esbuild BUNDLES into dist/background.js (build.js bundleBackground),
 * inlining its pure `@/lib/*` leaves (all migrated to src/ as TypeScript) and keeping
 * `./dig_client.js` EXTERNAL (the wasm-bindgen ESM that loads dig_client_bg.wasm via import.meta.url
 * + the runtime SRI pin — it MUST stay a runtime sibling import, plain-copied to dist root +
 * web_accessible, never inlined).
 *
 * This test pins that contract at the source level (the browser SW-registration harness under
 * e2e/sw/ validates the RUNTIME result — that the bundle actually registers + loads its wasm):
 *   1. background.js is NOT in build.js EXTENSION_FILES (it is bundled, not plain-copied);
 *   2. src/background/index.ts exists and imports its leaves via `@/…` (src), and its ONLY relative
 *      `./…` import is `./dig_client.js` (the external one) — no leftover `#shared/…` root imports;
 *   3. every `@/lib/X` leaf the SW imports exists under src/lib (so esbuild can inline it);
 *   4. dig_client.js + dig_client_bg.wasm remain in EXTENSION_FILES (the SW's external import needs
 *      them at dist root);
 *   5. build.js bundles src/background/index.ts (with the @ alias) and marks ./dig_client.js external.
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(ROOT, f), 'utf8');

test('the SW is bundled from src/background/index.ts, not plain-copied as root background.js', () => {
  const buildJs = read('build.js');
  // (1) background.js is not plain-copied — check the EXTENSION_FILES array only (build.js still
  // references `path.join(DIST_DIR, 'background.js')` for the BUNDLE output, which is expected).
  const filesArr = buildJs.slice(
    buildJs.indexOf('const EXTENSION_FILES'),
    buildJs.indexOf('const OPTIONAL_FILES'),
  );
  assert.ok(filesArr.length > 0, 'could not locate EXTENSION_FILES array in build.js');
  assert.ok(
    !/'background\.js'/.test(filesArr),
    'build.js EXTENSION_FILES must NOT list background.js — the SW is esbuild-bundled now.',
  );
  // (2) the SW source exists.
  assert.ok(existsSync(join(ROOT, 'src', 'background', 'index.ts')), 'src/background/index.ts must exist');
  // (5) build.js bundles it, resolves the @ alias, + keeps dig_client external.
  assert.match(buildJs, /background', 'index\.ts'/, 'build.js must reference src/background/index.ts');
  assert.match(buildJs, /alias: \{ '@': SRC_DIR/, 'build.js bundleBackground must resolve the @ -> src alias');
  assert.match(buildJs, /external-dig-client/, 'build.js must keep ./dig_client.js external for the SW bundle');
});

test('the SW imports its leaves via @/ (src) and only ./dig_client.js relatively (no #shared)', () => {
  const sw = read('src/background/index.ts');

  // Its leaves come from `@/…` (src/lib etc). Every migrated leaf must exist under src/.
  const aliased = new Set();
  for (const m of sw.matchAll(/from\s+['"]@\/([a-z0-9/-]+)['"]/gi)) aliased.add(m[1]);
  assert.ok(aliased.size > 0, 'expected the SW to import at least one @/… leaf');
  // (3) every @/X leaf resolves to a real src/X.ts (so esbuild can inline it).
  const missing = [...aliased].filter((f) => !existsSync(join(ROOT, 'src', `${f}.ts`)));
  assert.deepEqual(missing, [], `SW imports @/… leaves absent from src/: ${missing.join(', ')}`);

  // No leftover #shared/… imports (all root .mjs leaves have migrated to src/).
  assert.ok(
    !/from\s+['"]#shared\//.test(sw),
    'the SW must not import any #shared/… root leaf — they have all migrated to src/',
  );

  // (2) the ONLY relative `./…` import is ./dig_client.js (the external wasm-bindgen ESM).
  const rel = [...sw.matchAll(/from\s+['"](\.\/[^'"]+)['"]/g)].map((m) => m[1]);
  assert.deepEqual(rel, ['./dig_client.js'], `SW must import only ./dig_client.js relatively, found: ${rel.join(', ')}`);
});

test('dig_client.js + its wasm remain plain-copied to dist (the SW external import needs them)', () => {
  const buildJs = read('build.js');
  assert.match(buildJs, /'dig_client\.js'/, 'build.js EXTENSION_FILES must still copy dig_client.js');
  assert.match(buildJs, /'dig_client_bg\.wasm'/, 'build.js EXTENSION_FILES must still copy dig_client_bg.wasm');
});
