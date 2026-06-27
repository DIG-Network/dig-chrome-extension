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

// A deterministic, fake-but-realistic project id (32 hex chars, the Reown format). Used
// only to verify INJECTION happens — it is not a real relay credential. Passed via env,
// which takes precedence over the hub's .env.local in readProjectId(), so the assertions
// are deterministic AND never reference the real shared project id.
const TEST_PROJECT_ID = 'deadbeefdeadbeefdeadbeefdeadbeef';

// Run the real build ONCE, synchronously, at module load — before any test registers — with
// the test project id forced via env. Bundles WC + bakes the project id into dist/. Building
// here (not in a test.before hook) avoids cross-file hook/process ordering ambiguity under
// `node --test`, guaranteeing every assertion below sees THIS build's dist/. (~a few seconds
// for esbuild.) `execFileSync` throws on a non-zero exit, failing the suite loudly.
execFileSync(process.execPath, ['build.js'], {
  cwd: ROOT,
  env: { ...process.env, WALLETCONNECT_PROJECT_ID: TEST_PROJECT_ID },
  stdio: 'ignore',
});

test('source wallet-wc.js keeps the empty project-id sentinel (no committed literal)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'wallet-wc.js'), 'utf8');
  assert.match(src, /const DEFAULT_PROJECT_ID = '';/, 'source must NOT bake a project id');
});

test('build injects a non-empty default project id into dist/wallet-wc.js', () => {
  const dist = fs.readFileSync(path.join(DIST, 'wallet-wc.js'), 'utf8');
  // The empty sentinel must be gone, replaced by the injected value.
  assert.doesNotMatch(dist, /const DEFAULT_PROJECT_ID = '';/, 'sentinel should be replaced');
  const m = dist.match(/const DEFAULT_PROJECT_ID = "([^"]*)";/);
  assert.ok(m, 'injected default project id literal present');
  assert.ok(m[1].length > 0, 'injected default project id is non-empty');
  assert.equal(m[1], TEST_PROJECT_ID, 'injected value matches the build-time project id');
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
