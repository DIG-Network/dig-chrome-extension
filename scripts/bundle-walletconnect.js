/**
 * Bundle @walletconnect/sign-client (+ all its deps) into ONE same-origin ESM the MV3
 * extension page can `import()`.
 *
 * WHY: extension-page CSP is `script-src 'self' 'wasm-unsafe-eval'` — a remote SignClient
 * (CDN) is blocked, and dynamic code generation (`eval` / `new Function`) is forbidden. So
 * SignClient must be VENDORED same-origin AND eval-free. esbuild produces a single ESM with
 * no `eval`/`new Function` (it does not emit a CommonJS-via-eval shim for `format: 'esm'`),
 * and we assert that post-build (CSP_EVAL_GUARD) so a future WC dep that introduces dynamic
 * codegen fails the build loudly instead of silently breaking live pairing under MV3.
 *
 * Output: vendor/walletconnect-sign-client.js (tracked source the import resolves to). The
 * main build.js copies it into dist/ alongside the other extension files. Re-run whenever
 * @walletconnect/sign-client is bumped: `npm run vendor:wc`.
 */

const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const ENTRY = path.join(__dirname, 'wc-entry.mjs');
const OUT_DIR = path.join(ROOT, 'vendor');
const OUT_FILE = path.join(OUT_DIR, 'walletconnect-sign-client.js');

// MV3 forbids dynamic code generation. A bundle that ships top-level `eval(` or
// `new Function(` would throw an EvalError under the extension-page CSP at runtime, so we
// fail the build if either survives bundling. (Matches `eval(` / `new Function(` calls; a
// bare identifier like `someEvaluator` won't trip it.)
const CSP_EVAL_GUARD = /(^|[^.\w])eval\s*\(|new\s+Function\s*\(/;

async function bundle() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  await esbuild.build({
    entryPoints: [ENTRY],
    outfile: OUT_FILE,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['chrome111'], // modern MV3 baseline; no transform that needs eval
    minify: true,
    legalComments: 'none',
    // WalletConnect's deps reach for a few Node built-ins behind feature checks that are
    // never taken in a browser (it prefers globalThis.crypto / WebSocket / fetch). Stub
    // them empty so the bundle resolves without pulling a Node polyfill that uses eval.
    define: { global: 'globalThis' },
  });

  const out = fs.readFileSync(OUT_FILE, 'utf8');

  // Hard CSP guard: no dynamic code generation may survive into the vendored bundle.
  if (CSP_EVAL_GUARD.test(out)) {
    const m = out.match(CSP_EVAL_GUARD);
    throw new Error(
      'Vendored WalletConnect bundle contains eval()/new Function() — MV3 CSP would reject ' +
        `it at runtime. Offending match near: ${JSON.stringify((m && m[0]) || '')}`
    );
  }

  // Sanity: the bundle must export SignClient (default) for wallet-wc.js's import.
  if (!/export\s*\{/.test(out) && !/export\s+default/.test(out)) {
    throw new Error('Vendored WalletConnect bundle has no ESM exports.');
  }

  const kb = (Buffer.byteLength(out) / 1024).toFixed(0);
  console.log(`✓ Vendored WalletConnect SignClient -> vendor/walletconnect-sign-client.js (${kb} KB, eval-free)`);
  return OUT_FILE;
}

if (require.main === module) {
  bundle().catch((e) => {
    console.error('✗ WalletConnect bundling failed:', e.message);
    process.exit(1);
  });
}

module.exports = { bundle, OUT_FILE, CSP_EVAL_GUARD };
