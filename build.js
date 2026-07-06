/**
 * Build script for DIG Network Browser Extension
 * Prepares the extension for installation by validating and copying files
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const esbuild = require('esbuild');
const { bundle: bundleWalletConnect, OUT_FILE: WC_VENDOR_FILE } = require('./scripts/bundle-walletconnect');

// CLI flags. `--json` (machine mode) emits ONE JSON object to stdout, routes all human prose
// to stderr, and suppresses color — the ecosystem-wide CLI convention (AGENT_FRIENDLY.md).
const JSON_MODE = process.argv.includes('--json');
const MAKE_ZIP = process.argv.includes('--zip') || process.argv.includes('-z');

// Documented, stable build exit codes (see README). 0 success / 2 validation failed (a
// required source file is missing) / 3 a build step (vendoring / artifact write) failed.
const EXIT = Object.freeze({ SUCCESS: 0, VALIDATION_FAILED: 2, BUILD_STEP_FAILED: 3 });

const EXTENSION_FILES = [
  'manifest.json',
  // NB: the popup + full-page wallet UI (popup.html / app.html) are the React shell BUILT BY VITE
  // into dist-web/ and copied into dist/ by buildWebApp() below. The old hand-written vanilla popup
  // (popup.js / popup-wallet.js / popup.css) was superseded by the React shell (#56) and has been
  // removed. The pure view-models below are still copied because the vanilla service worker imports
  // them at runtime; the React bundle inlines its own copies via the #shared/* alias.
  // Pure popup view-models (tab routing, wallet number/validation logic, §5.3 resolve verdict).
  'tabs.mjs',
  'wallet-view.mjs',
  // Wallet asset registry + tracked-CAT list, and the offers (make/inspect/take/cancel) model.
  'wallet-assets.mjs',
  'wallet-offers.mjs',
  // QR renderer for the Receive view (bundled below to inline qrcode-generator for the browser).
  'qr.mjs',
  'dig-urn.mjs',
  // The dig-node install prompt/copy. (server-config + error-page migrated to src/lib as TS — #68;
  // they inline into the SW bundle + the vite page bundles, no longer plain-copied.)
  'dig-node-status.mjs',
  // Agent-friendly contracts: catalogued chia:// loader error codes (DIG_ERR_*, aligned with
  // docs error-codes.json) + the versioned background MESSAGE catalogue (ACTIONS enum +
  // getCapabilities self-description). Both imported at runtime by background.js.
  'error-codes.mjs',
  'messages.mjs',
  // DIG Control Panel (dig://control parity) decision logic + the DIG Shields per-resource
  // proof ledger (#134, byte-mirror of the browser's dig/shields/dig_ledger.mjs). Imported by
  // the React shell (#shared/* alias), the background SW, and the dig-viewer.
  'dig-control.mjs',
  'dig-ledger.mjs',
  // Ecosystem funnel: shared link constants. (The first-run welcome page welcome.html + its TS
  // entry src/entries/welcome.ts is BUILT BY VITE into dist-web/ and copied by buildWebApp() below.)
  'links.mjs',
  // DIG Home (new-tab override) — newtab.html + src/entries/newtab.ts (+ its co-located
  // newtab.css) is BUILT BY VITE into dist-web/ and copied by buildWebApp() below.
  // DIG settings (options_ui) — options.html + src/entries/options.ts (+ its co-located
  // options.css) is BUILT BY VITE into dist-web/ and copied by buildWebApp() below.
  // Shared app directory + omnibox classifier (NTP) and wallet method/broker modules.
  'apps.mjs',
  'wallet-methods.mjs',
  'wallet-broker.mjs',
  // Self-custody dApp walletRpc router + approval queue (#56 §5.5) — imported by the SW bundle.
  'dapp-approval.mjs',
  // WalletConnect → Sage transport (runs in the popup page).
  'wallet-wc.js',
  // NB: background.js (the MV3 module service worker) is NOT plain-copied — it is a strict entry at
  // src/background/index.ts that esbuild BUNDLES into dist/background.js by bundleBackground()
  // below (#68): the pure #shared/* leaves are inlined; ./dig_client.js is kept EXTERNAL (the
  // wasm-bindgen ESM that loads dig_client_bg.wasm via import.meta.url + the runtime SRI pin), so it
  // is still plain-copied to dist root (below) + web_accessible.
  //
  // NB: the three content-script-layer files are NOT plain-copied — they are strict-TS entries
  // under src/content/ that esbuild bundles into dist/middleware.js, dist/content.js, and
  // dist/page-script.js (SAME shipped filenames) by bundleContentScript()/bundlePageScript()/
  // bundleMiddleware() below. middleware.js + content.js are the manifest content_scripts
  // (isolated world); page-script.js is the web_accessible_resource injected into the MAIN world.
  //
  // NB: the injected window.chia provider (dist/dig-provider.js) is NOT plain-copied — it is
  // BUNDLED from dig-provider.entry.mjs + @dignetwork/chia-provider by bundleProvider() below,
  // so the injected surface is the shared package's, never a hand-copied divergent one.
  //
  // The DIG Viewer page dig-viewer.html + its TS entry src/entries/dig-viewer.ts is BUILT BY VITE
  // into dist-web/ and copied into dist/ by buildWebApp() below (Vite emits dig-viewer.html now).
  // The SW still opens it via getURL('dig-viewer.html') (filename unchanged).
  // Pure store-reference classifier/resolver (#55) — imported by the dig-viewer entry (the parent
  // side of the in-page store interceptor bridge). The DOM-glue interceptor itself is BUNDLED below
  // from store-interceptor.entry.mjs into dist/store-interceptor.js (not plain-copied).
  'store-refs.mjs',
  // dig-client WASM (ES module + binary) — required for client-side decryption in the module SW
  'dig_client.js',
  'dig_client_bg.wasm',
];

const OPTIONAL_FILES = [
  'test.html' // Test page for development
];

const ICON_SIZES = [16, 48, 128];
const DIST_DIR = path.join(__dirname, 'dist');
const ICONS_DIR = path.join(__dirname, 'icons');
const SRC_DIR = path.join(__dirname, 'src');
const FAVICON_PATH = path.join(SRC_DIR, 'favicon.png');

// The vendored WalletConnect SignClient ESM (built by scripts/bundle-walletconnect.js).
// Copied into dist/vendor/ so the popup's wallet-wc.js import resolves under MV3 CSP.
const WC_VENDOR_REL = path.join('vendor', 'walletconnect-sign-client.js');

// Where the hub bakes the shared Reown/WalletConnect project id (the SAME relay project id
// every DIG surface uses). Read at BUILD time and injected into dist/wallet-wc.js as the
// DEFAULT project id — NEVER written into a tracked source file or printed. (Client-public
// identifier, so it may land in the dist/ artifact the same way the hub ships NEXT_PUBLIC_*.)
const HUB_ENV_LOCAL = path.resolve(__dirname, '..', 'hub.dig.net', 'apps', 'web', '.env.local');
const PROJECT_ID_ENV_KEY = 'NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID';

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m'
};

// Human prose goes to stderr under --json (so stdout carries ONLY the JSON object) and is
// suppressed of color there; otherwise it goes to stdout colored as before.
function log(message, color = 'reset') {
  if (JSON_MODE) {
    process.stderr.write(message + '\n');
  } else {
    console.log(`${colors[color]}${message}${colors.reset}`);
  }
}

function checkFile(filePath, required = true) {
  const exists = fs.existsSync(filePath);
  if (!exists && required) {
    log(`❌ Missing required file: ${filePath}`, 'red');
    return false;
  } else if (!exists) {
    log(`⚠️  Optional file missing: ${filePath}`, 'yellow');
  } else {
    log(`✓ Found: ${filePath}`, 'green');
  }
  return exists;
}

function validateExtension() {
  log('\n🔍 Validating extension files...', 'blue');
  
  let allValid = true;
  
  // Check required files
  EXTENSION_FILES.forEach(file => {
    const filePath = path.join(__dirname, file);
    if (!checkFile(filePath, true)) {
      allValid = false;
    }
  });
  
  // Check favicon (required for extension icon)
  log('\n📦 Checking extension icon...', 'blue');
  const faviconExists = checkFile(FAVICON_PATH, false);
  
  if (!faviconExists) {
    log('\n⚠️  Extension icon (src/favicon.png) is missing.', 'yellow');
    log('   Note: Extension will work without icon, but Chrome will use a default icon.', 'yellow');
  }
  
  return allValid; // Icons are optional, don't fail build if missing
}

function createDistDirectory() {
  log('\n📁 Creating dist directory...', 'blue');
  
  if (fs.existsSync(DIST_DIR)) {
    log('Cleaning existing dist directory...', 'yellow');
    fs.rmSync(DIST_DIR, { recursive: true, force: true });
  }
  
  fs.mkdirSync(DIST_DIR, { recursive: true });
  
  log('✓ Dist directory created', 'green');
}

// Create a minimal valid PNG icon (placeholder)
// Uses a minimal 1x1 transparent PNG that Chrome will accept and scale
function createPlaceholderIcon(size) {
  // Minimal valid PNG: 1x1 transparent pixel
  // Chrome will scale this to the required size
  // Base64 encoded minimal PNG
  const base64PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  return Buffer.from(base64PNG, 'base64');
}

function copyFiles() {
  log('\n📋 Copying extension files...', 'blue');
  
  // Copy main extension files
  EXTENSION_FILES.forEach(file => {
    const src = path.join(__dirname, file);
    const dest = path.join(DIST_DIR, file);
    
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
      log(`✓ Copied: ${file}`, 'green');
    }
  });
  
  // Copy optional files (like test.html)
  OPTIONAL_FILES.forEach(file => {
    const src = path.join(__dirname, file);
    const dest = path.join(DIST_DIR, file);
    
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
      log(`✓ Copied: ${file} (optional)`, 'green');
    }
  });
  
  // Copy src directory (contains favicon.png and logo.png)
  const srcDir = path.join(__dirname, 'src');
  const distSrcDir = path.join(DIST_DIR, 'src');
  
  if (fs.existsSync(srcDir)) {
    // Create src directory in dist
    fs.mkdirSync(distSrcDir, { recursive: true });
    
    // Copy favicon.png (extension icon)
    const faviconSrc = path.join(srcDir, 'favicon.png');
    const faviconDest = path.join(distSrcDir, 'favicon.png');
    if (fs.existsSync(faviconSrc)) {
      fs.copyFileSync(faviconSrc, faviconDest);
      log(`✓ Copied: src/favicon.png (extension icon)`, 'green');
    } else {
      log(`⚠️  Favicon not found: ${faviconSrc}`, 'yellow');
    }
    
    // Copy logo.png
    const logoSrc = path.join(srcDir, 'logo.png');
    const logoDest = path.join(distSrcDir, 'logo.png');
    if (fs.existsSync(logoSrc)) {
      fs.copyFileSync(logoSrc, logoDest);
      log(`✓ Copied: src/logo.png`, 'green');
    } else {
      log(`⚠️  Logo not found: ${logoSrc}`, 'yellow');
    }

    // Copy the vector wordmark used by the popup header lockup.
    const wordmarkSrc = path.join(srcDir, 'Wordmark-Black.svg');
    const wordmarkDest = path.join(distSrcDir, 'Wordmark-Black.svg');
    if (fs.existsSync(wordmarkSrc)) {
      fs.copyFileSync(wordmarkSrc, wordmarkDest);
      log(`✓ Copied: src/Wordmark-Black.svg`, 'green');
    } else {
      log(`⚠️  Wordmark not found: ${wordmarkSrc}`, 'yellow');
    }
    // src/ only holds the favicon and logo assets above. (The old src/config,
    // src/core, src/utils "Framework" subsystem was unused by the shipping path
    // — manifest → background.js → dig_client.js WASM → rpc.dig.net — and was removed.)
  } else {
    log(`⚠️  Source directory not found: ${srcDir}`, 'yellow');
  }
  
  // Also copy logo.png to root of dist for popup.html reference
  const logoSrc = path.join(__dirname, 'src', 'logo.png');
  const logoDest = path.join(DIST_DIR, 'logo.png');
  if (fs.existsSync(logoSrc)) {
    fs.copyFileSync(logoSrc, logoDest);
    log(`✓ Copied: logo.png (to root)`, 'green');
  }
  
  
  log('\n✓ All files copied to dist/', 'green');
}

// Recursively copy a directory tree (src → dest), creating dirs as needed.
function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirRecursive(s, d);
    else fs.copyFileSync(s, d);
  }
}

const WEB_OUT_DIR = path.join(__dirname, 'dist-web');

/**
 * Build the React shell (popup + full-page app) with Vite and copy its output into dist/. This
 * emits the SHIPPED popup.html + app.html (with hashed, self-hosted asset references) plus the
 * bundled JS/CSS + vendored fonts. Plain Vite (not CRXJS) is used ONLY for the React pages so
 * build.js keeps owning the hand-tuned MV3 service worker, content scripts, injected provider,
 * WalletConnect vendoring, store interceptor, and the --zip release path unchanged.
 */
function buildWebApp() {
  log('\n⚛️  Building React shell (Vite: popup.html + app.html)...', 'blue');
  // Resolve vite's CLI entry via its package.json (its `exports` map doesn't expose ./bin/vite.js
  // to require.resolve, but ./package.json is exported — build the bin path from its dir).
  const viteBin = path.join(path.dirname(require.resolve('vite/package.json')), 'bin', 'vite.js');
  execSync(`node "${viteBin}" build`, { stdio: JSON_MODE ? 'ignore' : 'inherit', cwd: __dirname });
  if (!fs.existsSync(WEB_OUT_DIR)) {
    throw new Error('Vite build produced no dist-web/ output.');
  }
  copyDirRecursive(WEB_OUT_DIR, DIST_DIR);
  for (const page of ['popup.html', 'app.html', 'offscreen.html', 'approval.html', 'welcome.html', 'options.html', 'dig-viewer.html', 'newtab.html']) {
    if (!fs.existsSync(path.join(DIST_DIR, page))) {
      throw new Error(`React build missing ${page} in dist/ — the Vite multi-entry input changed?`);
    }
  }
  log('✓ Built + copied React shell (popup.html, app.html, offscreen.html, approval.html, welcome.html, options.html, dig-viewer.html, assets, fonts)', 'green');
}

function createZip() {
  log('\n📦 Creating zip file...', 'blue');
  
  try {
    // Check if zip command is available (Windows has it, Linux/Mac might need zip installed)
    const zipCommand = process.platform === 'win32' ? 'powershell' : 'zip';
    
    if (process.platform === 'win32') {
      // Use PowerShell Compress-Archive on Windows
      const zipPath = path.join(__dirname, `dig-network-extension-v${require('./package.json').version}.zip`);
      const distPath = path.join(DIST_DIR, '*');
      
      execSync(
        `powershell -Command "Compress-Archive -Path '${distPath}' -DestinationPath '${zipPath}' -Force"`,
        { stdio: 'inherit' }
      );
      
      log(`✓ Zip created: ${path.basename(zipPath)}`, 'green');
    } else {
      // Use zip command on Unix-like systems
      const zipPath = `dig-network-extension-v${require('./package.json').version}.zip`;
      
      execSync(
        `cd ${DIST_DIR} && zip -r ../${zipPath} .`,
        { stdio: 'inherit' }
      );
      
      log(`✓ Zip created: ${zipPath}`, 'green');
    }
  } catch (error) {
    log('⚠️  Could not create zip file. You can manually zip the dist/ folder.', 'yellow');
    log(`   Error: ${error.message}`, 'yellow');
  }
}

/**
 * Replace the `__APP_VERSION__` placeholder in the copied HTML pages (popup.html, control.html)
 * with package.json's version, so the shipped pages carry the real build in their <meta
 * name="app-version"> tag + footer (§6.7). Idempotent; a page without the placeholder is left as-is.
 */
function injectAppVersion() {
  const version = require('./package.json').version;
  for (const page of ['popup.html', 'app.html', 'approval.html']) {
    const dest = path.join(DIST_DIR, page);
    if (!fs.existsSync(dest)) continue;
    const src = fs.readFileSync(dest, 'utf8');
    if (!src.includes('__APP_VERSION__')) continue;
    fs.writeFileSync(dest, src.split('__APP_VERSION__').join(version));
    log(`✓ Injected app version ${version} into ${page}`, 'green');
  }
}

/**
 * Resolve the shared WalletConnect project id at build time.
 * Precedence: WALLETCONNECT_PROJECT_ID env var → hub apps/web/.env.local (NEXT_PUBLIC_…).
 * Returns '' if neither is available (build still succeeds; the options-page field then
 * remains the only way to set one). NEVER prints the value.
 */
function readProjectId() {
  const fromEnv = (process.env.WALLETCONNECT_PROJECT_ID || '').trim();
  if (fromEnv) return fromEnv;

  try {
    if (fs.existsSync(HUB_ENV_LOCAL)) {
      const text = fs.readFileSync(HUB_ENV_LOCAL, 'utf8');
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq === -1) continue;
        const key = line.slice(0, eq).trim();
        if (key !== PROJECT_ID_ENV_KEY) continue;
        let val = line.slice(eq + 1).trim();
        // Strip surrounding quotes if present.
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        return val.trim();
      }
    }
  } catch {
    /* fall through to '' — never surface the file contents */
  }
  return '';
}

/**
 * Inject the build-time default project id into dist/wallet-wc.js by replacing the source
 * sentinel `const DEFAULT_PROJECT_ID = '';`. The SOURCE file keeps '' (no committed literal);
 * only the dist/ artifact carries the baked value. The value is never logged.
 */
function injectProjectId(projectId) {
  const distWalletWc = path.join(DIST_DIR, 'wallet-wc.js');
  if (!fs.existsSync(distWalletWc)) {
    log('⚠️  dist/wallet-wc.js missing — cannot inject project id.', 'yellow');
    return false;
  }
  const src = fs.readFileSync(distWalletWc, 'utf8');
  const SENTINEL = /const DEFAULT_PROJECT_ID = '';/;
  if (!SENTINEL.test(src)) {
    log('⚠️  Project-id injection point not found in wallet-wc.js (sentinel changed?).', 'yellow');
    return false;
  }
  // JSON.stringify keeps the value an opaque JS string literal; no value echoed to logs.
  const replaced = src.replace(SENTINEL, `const DEFAULT_PROJECT_ID = ${JSON.stringify(projectId)};`);
  fs.writeFileSync(distWalletWc, replaced);
  if (projectId) {
    log('✓ Injected default WalletConnect project id into dist/wallet-wc.js', 'green');
  } else {
    log('⚠️  No WalletConnect project id available — dist default left empty (set one in DIG settings).', 'yellow');
  }
  return true;
}

/**
 * Generate dist/agent-surface.json — the machine-readable self-description of the extension
 * contract (message protocol, actions, wallet methods, error codes, provider surface). Built
 * from the same source modules the runtime imports so it can't drift. Returns the object.
 */
async function generateAgentSurface() {
  log('\n🤖 Generating agent-surface.json...', 'blue');
  // agent-surface.mjs is ESM; build.js is CommonJS → load it via dynamic import().
  const { buildAgentSurface } = await import('./agent-surface.mjs');
  const version = require('./package.json').version;
  const surface = buildAgentSurface(version);
  const dest = path.join(DIST_DIR, 'agent-surface.json');
  fs.writeFileSync(dest, JSON.stringify(surface, null, 2));
  log('✓ Wrote: agent-surface.json', 'green');
  return surface;
}

// The MAIN-world injected provider entry (imports @dignetwork/chia-provider's buildProvider and
// wraps it with the extension's postMessage transport). esbuild inlines the package into a single
// IIFE — the MAIN world has no ES import at runtime.
const PROVIDER_ENTRY = path.join(SRC_DIR, 'entries', 'dig-provider.entry.ts');
const PROVIDER_OUT = path.join(DIST_DIR, 'dig-provider.js');

// Guard: the bundled injected provider must be a self-contained IIFE (no runtime import/require)
// and must carry the shared-package surface (isGoby, requestAccounts, walletSwitchChain) so a
// regression that fails to bundle the package fails the build loudly instead of shipping a stub.
const PROVIDER_ESM_LEAK = /(^|[^.\w])(import|export)\s|(^|[^.\w])require\s*\(/m;

/**
 * Bundle the injected `window.chia` provider from dig-provider.entry.mjs + the shared
 * @dignetwork/chia-provider package into dist/dig-provider.js as a single MAIN-world IIFE.
 * The injected surface is thus the SHARED package's buildProvider output — never a hand-copied
 * divergent one — wrapped with the extension's postMessage bridge transport.
 */
async function bundleProvider() {
  log('\n🪪 Bundling injected window.chia provider (@dignetwork/chia-provider)...', 'blue');
  await esbuild.build({
    entryPoints: [PROVIDER_ENTRY],
    outfile: PROVIDER_OUT,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['chrome111'],
    legalComments: 'none',
    // Readable output (not minified) so the shipped provider stays auditable.
    minify: false,
  });
  const out = fs.readFileSync(PROVIDER_OUT, 'utf8');
  // Must be a self-contained IIFE: no unresolved ES import/export or CJS require survived bundling.
  if (PROVIDER_ESM_LEAK.test(out)) {
    const m = out.match(PROVIDER_ESM_LEAK);
    throw new Error(
      'Bundled dig-provider.js still contains an ES import/export or require() — the package did ' +
        `not inline. Offending match near: ${JSON.stringify((m && m[0]) || '')}`
    );
  }
  // Must carry the shared-package surface (proves buildProvider was bundled, not a stub).
  for (const needle of ['window.chia', 'isGoby', 'requestAccounts', 'walletSwitchChain']) {
    if (!out.includes(needle)) {
      throw new Error(`Bundled dig-provider.js is missing "${needle}" — @dignetwork/chia-provider was not bundled.`);
    }
  }
  const kb = (Buffer.byteLength(out) / 1024).toFixed(0);
  log(`✓ Bundled: dig-provider.js (${kb} KB, shared @dignetwork/chia-provider surface)`, 'green');
}

// wallet-methods.mjs re-exports the CHIP-0002 method surface from the @dignetwork/chia-provider
// package (a BARE specifier). Browsers + MV3 module service workers cannot resolve bare specifiers,
// so the raw copy breaks the whole module graph that imports it (the popup controller AND the
// background SW, via messages.mjs). Bundle it to a self-contained ESM at build time — esbuild
// inlines the package while preserving the same named exports, so every consumer's `import
// './wallet-methods.mjs'` resolves in the browser with no source change.
const WALLET_METHODS_SRC = path.join(__dirname, 'wallet-methods.mjs');
const WALLET_METHODS_OUT = path.join(DIST_DIR, 'wallet-methods.mjs');
// After bundling there must be NO surviving bare @dignetwork import (that would re-break the graph).
const BARE_DIGNETWORK_IMPORT = /from\s+['"]@dignetwork\//;

async function bundleWalletMethods() {
  log('\n🧩 Bundling wallet-methods.mjs (inline @dignetwork/chia-provider for the browser)...', 'blue');
  await esbuild.build({
    entryPoints: [WALLET_METHODS_SRC],
    outfile: WALLET_METHODS_OUT,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['chrome111'],
    legalComments: 'none',
    minify: false,
    allowOverwrite: true,
  });
  const out = fs.readFileSync(WALLET_METHODS_OUT, 'utf8');
  if (BARE_DIGNETWORK_IMPORT.test(out)) {
    throw new Error('dist/wallet-methods.mjs still has a bare @dignetwork import — the package did not inline.');
  }
  for (const needle of ['WALLET_METHODS', 'STATE_CHANGING_METHODS', 'normalizeMethod']) {
    if (!out.includes(needle)) {
      throw new Error(`Bundled wallet-methods.mjs is missing export "${needle}".`);
    }
  }
  log('✓ Bundled: wallet-methods.mjs (self-contained ESM, browser-safe)', 'green');
}

// qr.mjs imports the `qrcode-generator` package (a BARE specifier browsers + MV3 can't resolve).
// Bundle it to a self-contained ESM at build time (esbuild inlines the package while preserving the
// `qrSvg` export), so the popup's `import './qr.mjs'` resolves in the browser with no source change.
const QR_SRC = path.join(__dirname, 'qr.mjs');
const QR_OUT = path.join(DIST_DIR, 'qr.mjs');

async function bundleQr() {
  log('\n🔳 Bundling qr.mjs (inline qrcode-generator for the browser)...', 'blue');
  await esbuild.build({
    entryPoints: [QR_SRC],
    outfile: QR_OUT,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['chrome111'],
    legalComments: 'none',
    minify: false,
    allowOverwrite: true,
  });
  const out = fs.readFileSync(QR_OUT, 'utf8');
  if (/from\s+['"]qrcode-generator['"]/.test(out)) {
    throw new Error('dist/qr.mjs still has a bare qrcode-generator import — the package did not inline.');
  }
  if (!out.includes('qrSvg')) {
    throw new Error('Bundled qr.mjs is missing the qrSvg export.');
  }
  log('✓ Bundled: qr.mjs (self-contained ESM, browser-safe)', 'green');
}

// The in-page STORE INTERCEPTOR (#55) runs inside the sandboxed, opaque-origin `data:` frame that
// dig-viewer renders store HTML into. An opaque frame can neither import an ES module nor fetch a
// cross-origin script, so the interceptor MUST be a single self-contained IIFE that dig-viewer.js
// inlines into the frame document. esbuild bundles store-interceptor.entry.mjs (which imports the
// unit-tested store-refs.mjs) into dist/store-interceptor.js with the pure logic inlined.
const STORE_INTERCEPTOR_SRC = path.join(SRC_DIR, 'entries', 'store-interceptor.entry.ts');
const STORE_INTERCEPTOR_OUT = path.join(DIST_DIR, 'store-interceptor.js');

async function bundleStoreInterceptor() {
  log('\n🧩 Bundling store-interceptor.js (in-page relative-asset interceptor, #55)...', 'blue');
  await esbuild.build({
    entryPoints: [STORE_INTERCEPTOR_SRC],
    outfile: STORE_INTERCEPTOR_OUT,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['chrome111'],
    legalComments: 'none',
    minify: false,
    // Resolve `#shared/*` to the repo-root shared .mjs (store-refs) so it inlines into the IIFE.
    alias: { '#shared': __dirname },
  });
  const out = fs.readFileSync(STORE_INTERCEPTOR_OUT, 'utf8');
  // Must be self-contained (store-refs inlined; no surviving ES import) and must NOT contain a
  // literal `</script>` sequence (dig-viewer inlines this into a data: <script> block).
  if (PROVIDER_ESM_LEAK.test(out)) {
    throw new Error('Bundled store-interceptor.js still contains an ES import/export — store-refs did not inline.');
  }
  if (/<\/script/i.test(out)) {
    throw new Error('Bundled store-interceptor.js contains a literal </script> — would break the inlined <script> block.');
  }
  for (const needle of ['__DIG_CFG', 'read-result']) {
    if (!out.includes(needle)) {
      throw new Error(`Bundled store-interceptor.js is missing "${needle}" — the interceptor did not bundle correctly.`);
    }
  }
  log('✓ Bundled: store-interceptor.js (self-contained IIFE, store-refs inlined)', 'green');
}

// The three content-script-layer entries (issue #68 — strict-TS reorg under src/content/). Each is
// a self-contained classic script (ZERO imports) that esbuild bundles into an IIFE at the SAME
// shipped filename manifest.json already references, so no manifest change is needed:
//   src/content/middleware.ts  → dist/middleware.js   (content_scripts, isolated world)
//   src/content/content.ts     → dist/content.js      (content_scripts, isolated world)
//   src/content/page-script.ts → dist/page-script.js  (web_accessible_resource, MAIN world)
// middleware + content share the isolated-world global scope (they promote/read a few symbols via
// globalThis); page-script talks to content only over postMessage.
const CONTENT_ENTRIES = [
  {
    src: path.join(SRC_DIR, 'content', 'middleware.ts'),
    out: path.join(DIST_DIR, 'middleware.js'),
    // A stable string unique to middleware.ts — proves the real file bundled, not an empty stub.
    needle: 'DIG Extension: RPC host updated to:',
  },
  {
    src: path.join(SRC_DIR, 'content', 'content.ts'),
    out: path.join(DIST_DIR, 'content.js'),
    needle: 'DIG Extension: Content script v2.0 loaded',
  },
  {
    src: path.join(SRC_DIR, 'content', 'page-script.ts'),
    out: path.join(DIST_DIR, 'page-script.js'),
    needle: 'DIG Extension: Page script loaded',
  },
];

// A surviving ES import/export/require in the bundle means esbuild failed to produce a
// self-contained classic script — the browser would then throw on the content script. This is a
// stricter cousin of PROVIDER_ESM_LEAK that EXCLUDES the CSS `@import url(...)` these files carry
// in template strings/regexes (the `@` before `import` rules it out) so a valid bundle isn't
// falsely rejected. Real leaks look like `import{`/`import"`/`import '`/`export {`/`require(`.
const CONTENT_SCRIPT_ESM_LEAK = /(^|[^.\w@])(import|export)\s*["'{*]|(^|[^.\w])require\s*\(/m;

/**
 * Bundle one src/content/*.ts entry into its shipped dist/*.js as a self-contained IIFE (classic
 * script — content scripts are NOT ES modules). Guards that no ES import/export/require survived
 * and that a stable needle string is present, so a broken bundle fails the build loudly.
 */
async function bundleContentEntry(entry) {
  const name = path.basename(entry.out);
  log(`\n🧩 Bundling ${name} (src/content/${path.basename(entry.src)}, #68)...`, 'blue');
  await esbuild.build({
    entryPoints: [entry.src],
    outfile: entry.out,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['chrome111'],
    legalComments: 'none',
    minify: false,
    allowOverwrite: true,
  });
  const out = fs.readFileSync(entry.out, 'utf8');
  if (CONTENT_SCRIPT_ESM_LEAK.test(out)) {
    const m = out.match(CONTENT_SCRIPT_ESM_LEAK);
    throw new Error(
      `Bundled ${name} still contains an ES import/export or require() — it is not a self-contained ` +
        `classic script. Offending match near: ${JSON.stringify((m && m[0]) || '')}`
    );
  }
  if (!out.includes(entry.needle)) {
    throw new Error(`Bundled ${name} is missing "${entry.needle}" — the source did not bundle correctly.`);
  }
  const kb = (Buffer.byteLength(out) / 1024).toFixed(0);
  log(`✓ Bundled: ${name} (${kb} KB, self-contained classic script)`, 'green');
}

/** Bundle all three content-script-layer entries (middleware.js, content.js, page-script.js). */
async function bundleContentScripts() {
  for (const entry of CONTENT_ENTRIES) {
    await bundleContentEntry(entry);
  }
}

// The MV3 module service worker (#68 — §6.4 reorg). src/background/index.ts is esbuild-BUNDLED into
// dist/background.js as an ES module (manifest `"type": "module"`): the pure #shared/* leaves are
// inlined, but ./dig_client.js is kept EXTERNAL — it is the wasm-bindgen ESM that loads
// dig_client_bg.wasm via import.meta.url + the runtime SRI pin, so it MUST remain a runtime sibling
// import (plain-copied to dist root + web_accessible_resource), never inlined.
const BACKGROUND_SRC = path.join(SRC_DIR, 'background', 'index.ts');
const BACKGROUND_OUT = path.join(DIST_DIR, 'background.js');

async function bundleBackground() {
  log('\n⚙️  Bundling module service worker (src/background/index.ts → dist/background.js, #68)...', 'blue');
  await esbuild.build({
    entryPoints: [BACKGROUND_SRC],
    outfile: BACKGROUND_OUT,
    bundle: true,
    format: 'esm', // MV3 module service worker (manifest background.type === 'module')
    platform: 'browser',
    target: ['chrome111'],
    legalComments: 'none',
    minify: false,
    // @/* → src/* (migrated leaves) and #shared/* → repo root (leaves not yet moved under src/) —
    // both inline into the SW bundle. Mirrors the tsconfig/vite/vitest path aliases.
    alias: { '@': SRC_DIR, '#shared': __dirname },
    // Keep ./dig_client.js an external runtime import (see note above) — never inline it.
    plugins: [
      {
        name: 'external-dig-client',
        setup(b) {
          b.onResolve({ filter: /(^|\/)dig_client\.js$/ }, () => ({ path: './dig_client.js', external: true }));
        },
      },
    ],
    allowOverwrite: true,
  });
  const out = fs.readFileSync(BACKGROUND_OUT, 'utf8');
  // dig_client.js MUST stay an external runtime import (not inlined) — the wasm URL + SRI depend on it.
  if (!/from\s*["']\.\/dig_client\.js["']/.test(out)) {
    throw new Error('Bundled background.js did not keep ./dig_client.js as an external import (wasm URL/SRI would break).');
  }
  // No surviving #shared/@dignetwork import (a leaf failed to inline → the SW would fail to load).
  if (/from\s*["']#shared\//.test(out) || /from\s*["']@dignetwork\//.test(out)) {
    throw new Error('Bundled background.js still has an unresolved #shared/ or @dignetwork/ import — a leaf did not inline.');
  }
  // A stable string unique to the real SW proves it bundled (not an empty/stub output).
  if (!out.includes('DIG_CLIENT_WASM_SHA256')) {
    throw new Error('Bundled background.js is missing the DIG_CLIENT_WASM_SHA256 SRI pin — wrong/empty bundle.');
  }
  const kb = (Buffer.byteLength(out) / 1024).toFixed(0);
  log(`✓ Bundled: background.js (${kb} KB, ESM module SW; dig_client.js external, leaves inlined)`, 'green');
}

/** Build (if needed) and copy the vendored WalletConnect SignClient ESM into dist/vendor/. */
async function vendorWalletConnect() {
  log('\n🔌 Vendoring WalletConnect SignClient (esbuild)...', 'blue');
  try {
    await bundleWalletConnect();
  } catch (e) {
    log(`❌ WalletConnect bundling failed: ${e.message}`, 'red');
    throw e;
  }
  const distVendorDir = path.join(DIST_DIR, 'vendor');
  fs.mkdirSync(distVendorDir, { recursive: true });
  const dest = path.join(distVendorDir, 'walletconnect-sign-client.js');
  fs.copyFileSync(WC_VENDOR_FILE, dest);
  log('✓ Copied: vendor/walletconnect-sign-client.js', 'green');
}

async function main() {
  log('🚀 Building DIG Network Browser Extension...\n', 'blue');

  // Validate
  const isValid = validateExtension();
  if (!isValid) {
    log('\n❌ Validation failed. Please fix the errors above.', 'red');
    emitJsonResult({ ok: false, error: { code: 'VALIDATION_FAILED', message: 'A required source file is missing.' } });
    process.exit(EXIT.VALIDATION_FAILED);
  }

  // Create dist directory
  createDistDirectory();

  // Copy files
  copyFiles();

  // Build the React shell (popup.html + app.html) with Vite and copy it into dist/.
  buildWebApp();

  // Stamp the extension version (from package.json) into the HTML pages so every frontend surfaces
  // its build in all three §6.7 forms: a visible footer, <meta name="app-version">, and (via the
  // page script) window.__APP_VERSION__. The SOURCE keeps the __APP_VERSION__ placeholder.
  injectAppVersion();

  // Vendor the WalletConnect SignClient (same-origin ESM for MV3) into dist/vendor/.
  await vendorWalletConnect();

  // Bundle the injected window.chia provider from the shared @dignetwork/chia-provider package
  // into dist/dig-provider.js (single IIFE for the page MAIN world).
  await bundleProvider();

  // Bundle wallet-methods.mjs so its @dignetwork/chia-provider re-export resolves in the browser +
  // MV3 SW (bare specifiers don't). Must run AFTER copyFiles (which places the raw copy).
  await bundleWalletMethods();

  // Bundle qr.mjs so its qrcode-generator import resolves in the browser (bare specifier). Runs
  // AFTER copyFiles (which places the raw copy) so the inlined bundle overwrites it.
  await bundleQr();

  // Bundle the in-page store interceptor (#55) into dist/store-interceptor.js as a self-contained
  // IIFE (store-refs.mjs inlined) so dig-viewer can inline it into the sandboxed store frame.
  await bundleStoreInterceptor();

  // Bundle the three content-script-layer entries (src/content/*.ts → dist/middleware.js,
  // dist/content.js, dist/page-script.js) as self-contained IIFE classic scripts (#68).
  await bundleContentScripts();

  // Bundle the MV3 module service worker (src/background/index.ts → dist/background.js) as an ESM
  // SW with the #shared/* leaves inlined + ./dig_client.js kept external (#68).
  await bundleBackground();

  // Inject the shared WalletConnect project id into dist/wallet-wc.js (build-time only;
  // never a committed source literal, never logged).
  injectProjectId(readProjectId());

  // Emit the machine-readable agent-surface index (single source of truth: messages.mjs etc).
  const surface = await generateAgentSurface();

  // Create zip (optional)
  if (MAKE_ZIP) {
    createZip();
  }

  log('\n✅ Build complete!', 'green');
  log('\n📝 To install the extension:', 'blue');
  log('   1. Open Chrome/Edge/Brave');
  log('   2. Go to chrome://extensions/ (or edge://extensions/)');
  log('   3. Enable "Developer mode"');
  log('   4. Click "Load unpacked"');
  log(`   5. Select the "${path.basename(DIST_DIR)}" folder\n`, 'blue');

  // Under --json, emit ONE structured result object to stdout (the convention agents parse).
  emitJsonResult({
    ok: true,
    schemaVersion: 1,
    name: surface.name,
    version: surface.version,
    distDir: path.basename(DIST_DIR),
    zip: MAKE_ZIP,
    artifacts: ['manifest.json', 'background.js', 'agent-surface.json'],
    agentSurface: surface,
  });
}

/** Print the single JSON result object to stdout when --json is set; otherwise a no-op. */
function emitJsonResult(obj) {
  if (JSON_MODE) process.stdout.write(JSON.stringify(obj) + '\n');
}

main().catch((e) => {
  log(`\n❌ Build failed: ${e.message}`, 'red');
  emitJsonResult({ ok: false, error: { code: 'BUILD_STEP_FAILED', message: String(e && e.message || e) } });
  process.exit(EXIT.BUILD_STEP_FAILED);
});

