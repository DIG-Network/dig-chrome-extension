/**
 * Chrome-Web-Store manifest transform (#710). The `--store` build must emit a manifest CWS accepts:
 * no `key` (CWS assigns the id), no `update_url` (CWS rejects self-hosted updates), and a PLAIN
 * `X.Y.Z` version (never the 4-part nightly build-number `chromeManifestVersion` mints for a
 * self-hosted CRX). These pin the pure transform in crx.js and its wiring in build.js.
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const crx = require('../crx.js');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(ROOT, f), 'utf8');

// A source manifest carrying BOTH a `key` and an `update_url` — the fixture must exhibit both
// self-hosting markers so the transform is proven to strip each (an absent field can't test removal).
const SOURCE = Object.freeze({
  manifest_version: 3,
  name: 'DIG Network Extension',
  key: 'PUBKEY-BASE64',
  update_url: 'https://updates.dig.net/ext/stable/updates.xml',
  version: '1.29.1',
  version_name: 'leftover',
  permissions: ['storage'],
});

test('toStoreManifest strips key, update_url, and version_name', () => {
  const out = crx.toStoreManifest(SOURCE, '1.104.0');
  assert.ok(!('key' in out), 'key must be removed (CWS assigns the id)');
  assert.ok(!('update_url' in out), 'update_url must be removed (CWS rejects self-hosted updates)');
  assert.ok(!('version_name' in out), 'version_name must be removed for a store build');
  // Non-packaging fields are preserved untouched.
  assert.equal(out.name, 'DIG Network Extension');
  assert.deepEqual(out.permissions, ['storage']);
});

test('toStoreManifest does not mutate the source manifest', () => {
  const before = JSON.stringify(SOURCE);
  crx.toStoreManifest(SOURCE, '1.104.0');
  assert.equal(JSON.stringify(SOURCE), before, 'the source manifest must be left untouched');
});

test('storeManifestVersion reduces any version to a plain X.Y.Z', () => {
  assert.equal(crx.storeManifestVersion('1.104.0'), '1.104.0');
  // A nightly must NOT become the 4-part day-counter chromeManifestVersion mints — this is the
  // property that distinguishes the store transform from the dev/CRX one.
  const nightly = '1.104.0-nightly.20260101.abc1234';
  assert.equal(crx.storeManifestVersion(nightly), '1.104.0');
  assert.notEqual(crx.storeManifestVersion(nightly), crx.chromeManifestVersion(nightly));
  assert.match(crx.storeManifestVersion(nightly), /^\d+\.\d+\.\d+$/);
});

test('storeManifestVersion rejects a non-semver version', () => {
  assert.throws(() => crx.storeManifestVersion('not-a-version'), /expected an X\.Y\.Z semver/);
});

test('build.js takes the store transform under --store, leaving the dev path intact', () => {
  const buildJs = read('build.js');
  assert.match(buildJs, /process\.argv\.includes\(['"]--store['"]\)/, 'build.js must recognise --store');
  assert.match(buildJs, /crx\.toStoreManifest\(/, 'build.js must use crx.toStoreManifest under --store');
  // The dev path (chromeManifestVersion + version_name) must still exist for non-store builds.
  assert.match(buildJs, /crx\.chromeManifestVersion\(/, 'the dev manifest path must remain');
});

test('build.js zips deterministically via zip.js (no shell zip / Compress-Archive)', () => {
  const buildJs = read('build.js');
  assert.match(buildJs, /zip\.zipDir\(/, 'build.js must zip via the deterministic zip.js');
  // The broken PowerShell fallback is gone: no `powershell` invocation survives for zipping (the
  // word may still appear in an explanatory comment, but never as an executed command).
  assert.doesNotMatch(buildJs, /powershell/i, 'no powershell/Compress-Archive invocation may remain');
});

test('the Chrome Web Store publish workflow packages via the --store build', () => {
  // Coherence guard (#710): the CWS upload must ship the store-valid zip (no key / no update_url),
  // never the --zip sideload artifact — otherwise the store mode is unused and CWS gets the key.
  const wf = read('.github/workflows/publish-chrome-web-store.yml');
  assert.match(wf, /npm run build:store/, 'CWS workflow must build the store package');
  assert.match(wf, /dig-network-extension-store-v\*\.zip/, 'CWS workflow must upload the store zip');
  assert.doesNotMatch(wf, /npm run build:zip/, 'CWS workflow must not use the sideload --zip build');
});
