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
    /require\(['"]\.\/package\.json['"]\)\.version/,
    'build.js must source the manifest version from package.json at build time',
  );
});

test('build.js keeps manifest.version Chrome-valid for a nightly prerelease + preserves the full string in version_name (#596)', () => {
  // A nightly build stamps package.json with a semver PRERELEASE version `X.Y.Z-nightly.YYYYMMDD.<sha>`.
  // Chrome's manifest `version` MUST be 1–4 dotted integers, so the prerelease suffix would make the
  // packaged zip fail to load. build.js must strip the suffix for `version` (so the sideload zip
  // still loads) and preserve the FULL string in `version_name` (Chrome's human-readable label +
  // §6.7 bug-report attribution). A stable build (no suffix) sets no version_name.
  const buildJs = read('build.js');
  const crxJs = read('crx.js');
  // The Chrome-valid-version derivation now lives in the pure, unit-tested crx.chromeManifestVersion
  // (#607); build.js must delegate to it rather than re-deriving inline.
  assert.match(
    buildJs,
    /crx\.chromeManifestVersion\(/,
    'build.js must derive the manifest.version via crx.chromeManifestVersion()',
  );
  // crx.js is the module that strips a semver prerelease/build suffix (`-`/`+`) to a dotted base.
  assert.match(
    crxJs,
    /\.split\(\s*\/\[\-\+\]\/\s*\)/,
    'crx.js must split the version on `-`/`+` to derive the dotted-integer base',
  );
  // build.js still assigns the full string to version_name only when it differs from the dotted base.
  assert.match(
    buildJs,
    /manifest\.version_name\s*=/,
    'build.js must set manifest.version_name to the full version string for a prerelease build',
  );
});

test('the source manifest.json is well-formed JSON with a version field (the field itself is overwritten at build time)', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(typeof manifest.version, 'string');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
});
