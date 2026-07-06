/**
 * Regression (#139): manifest.json's `version` MUST track package.json's, or the shipped extension
 * reports the wrong build in bug reports (§6.7 app-version attribution). The manifest.json checked
 * into the repo drifted once (1.29.1 vs package.json's 1.37.1) because it was a hand-edited literal
 * nobody remembered to bump. build.js now injects package.json's version into dist/manifest.json at
 * build time instead of plain-copying the source file's (possibly stale) version field.
 *
 * This pins the injection at the source level (mirrors the sw-worker-imports.test.mjs pattern) —
 * the e2e/sw harness build validates the actual dist/manifest.json output at runtime.
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

test('build.js injects package.json version into dist/manifest.json (never plain-copies it)', () => {
  const buildJs = read('build.js');
  assert.match(
    buildJs,
    /file === 'manifest\.json'/,
    'build.js must special-case manifest.json in the extension-files copy loop',
  );
  assert.match(
    buildJs,
    /manifest\.version\s*=\s*require\(['"]\.\/package\.json['"]\)\.version/,
    'build.js must overwrite the manifest version with package.json\'s at build time',
  );
});

test('the source manifest.json is well-formed JSON with a version field (the field itself is overwritten at build time)', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(typeof manifest.version, 'string');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
});
