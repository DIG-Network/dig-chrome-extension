/**
 * Supply-chain lockdown gate (#67 P0-1a). Pins the three pieces that keep a malicious dependency
 * install-script from running with ambient authority beside the seed-holding offscreen bundle:
 *
 *   1. `.npmrc` sets `ignore-scripts=true` — `npm ci` runs NO dependency lifecycle script.
 *   2. `allowed-install-scripts.json` is the reviewed allowlist of packages permitted an install
 *      script (re-run by `npm run allow-scripts`).
 *   3. `scripts/allow-scripts.mjs --check` FAILS if any INSTALLED dependency ships a preinstall/
 *      install/postinstall that is not on the allowlist (drift → a review gate). This test runs that
 *      check, so a newly-introduced script-bearing dependency reddens CI until it is reviewed +
 *      allowlisted.
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

test('.npmrc denies dependency install scripts by default (ignore-scripts=true)', () => {
  const npmrc = fs.readFileSync(path.join(ROOT, '.npmrc'), 'utf8');
  assert.match(npmrc, /^\s*ignore-scripts\s*=\s*true\s*$/m, '.npmrc must set ignore-scripts=true');
});

test('allowed-install-scripts.json is a reviewed allowlist array', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'allowed-install-scripts.json'), 'utf8'));
  assert.ok(Array.isArray(raw.allow), 'has an `allow` array');
  // Every entry is a bare package name (no wildcards) — an audited, specific package.
  for (const name of raw.allow) assert.equal(typeof name, 'string', `${name} is a string`);
});

test('no unlisted dependency ships an install script (drift gate passes)', () => {
  // Throws (fails the test) if allow-scripts.mjs exits non-zero — i.e. a script-bearing dep is not
  // allowlisted. Requires node_modules to be installed (CI installs before running the suite).
  execFileSync(process.execPath, ['scripts/allow-scripts.mjs', '--check'], {
    cwd: ROOT,
    stdio: 'ignore',
  });
});
