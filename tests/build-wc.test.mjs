/**
 * Tests for the WalletConnect build wiring (scripts/bundle-walletconnect.js + build.js).
 *
 * These pin the two pieces required for LIVE Sage pairing in an MV3 extension:
 *   1. The SignClient is VENDORED as a single same-origin ESM (extension-page CSP blocks a
 *      CDN load) and is EVAL-FREE (MV3 forbids eval/new Function), loads as ESM, and exports
 *      SignClient with an .init() — so wallet-wc.js's dynamic import resolves and can pair.
 *   2. The build INJECTS a non-empty default WalletConnect project id into dist/wallet-wc.js
 *      at build time, while the SOURCE file keeps the empty sentinel (no committed literal).
 *
 * The build runs once here with a deterministic test project id passed via the
 * WALLETCONNECT_PROJECT_ID env (so the test does not depend on the hub's .env.local).
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

// Run the real build ONCE, synchronously, at module load — before any test registers — so every
// assertion below sees THIS build's dist/ (the vendored WalletConnect SignClient bundle). Building
// here (not in a test.before hook) avoids cross-file hook/process ordering ambiguity under
// `node --test`. (~a few seconds for esbuild.) `execFileSync` throws on a non-zero exit, failing
// the suite loudly. (#68: the legacy wallet-wc.js + its build-time project-id injection were
// removed — the live React shell sources the projectId from chrome.storage — so those assertions
// are gone; the vendored SignClient bundle below is still built + consumed by transport.ts.)
execFileSync(process.execPath, ['build.js'], {
  cwd: ROOT,
  stdio: 'ignore',
});

test('vendored WalletConnect bundle exists in dist/vendor/ and is non-trivial', () => {
  const p = path.join(DIST, 'vendor', 'walletconnect-sign-client.js');
  assert.ok(fs.existsSync(p), 'dist/vendor/walletconnect-sign-client.js exists');
  const bytes = fs.statSync(p).size;
  assert.ok(bytes > 50_000, `bundle should be a real SignClient bundle (got ${bytes} bytes)`);
});

test('vendored bundle is EVAL-FREE (MV3 CSP forbids eval / new Function)', () => {
  const p = path.join(DIST, 'vendor', 'walletconnect-sign-client.js');
  const code = fs.readFileSync(p, 'utf8');
  assert.doesNotMatch(code, /(^|[^.\w])eval\s*\(/, 'no eval(');
  assert.doesNotMatch(code, /new\s+Function\s*\(/, 'no new Function(');
});

test('vendored bundle loads as ESM and exports SignClient with .init()', async () => {
  // Copy to a .mjs so Node parses it as ESM (the package.json is CommonJS; the browser/
  // extension page always loads a dynamic import() as ESM regardless of extension).
  const src = path.join(DIST, 'vendor', 'walletconnect-sign-client.js');
  const tmp = path.join(ROOT, 'tests', `_wc-loadtest-${process.pid}.mjs`);
  fs.copyFileSync(src, tmp);
  try {
    const mod = await import(pathToFileURL(tmp).href);
    const SignClient = mod.default || mod.SignClient || mod;
    assert.equal(typeof SignClient, 'function', 'SignClient is a class/function');
    assert.equal(typeof SignClient.init, 'function', 'SignClient.init is callable');
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});
