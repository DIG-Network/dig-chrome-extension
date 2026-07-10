import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const rootDir = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(rootDir, 'package.json'), 'utf8')) as { version: string };

// Plain Vite multi-page build for the extension's React surfaces (popup + full page). CRXJS
// was evaluated but rejected: it would take over building the hand-tuned MV3 service worker,
// content scripts, injected provider, WalletConnect vendoring, and store-interceptor that
// build.js owns (and whose SW relative-link routing shipped in v1.5.1). Keeping those in
// build.js and using plain Vite ONLY for the React pages preserves that path byte-for-byte.
// HMR is not relied upon (MV3 extension_pages CSP is `script-src 'self'`); production builds
// are the only shipped builds. build.js runs `vite build` then copies dist-web/* into dist/.
export default defineConfig({
  base: './',
  // wasm() + topLevelAwait() let the offscreen bundle import the wasm-bindgen bundler-target
  // `chia-wallet-sdk-wasm` (self-custody HD derivation + coinset scan) and
  // `@dignetwork/chip35-dl-coin-wasm` (#228 — the DataLayer store-coin driver, for the coinset
  // chain-anchored-root walk); the wasm self-inits via top-level await. The extension_pages CSP
  // already allows `'wasm-unsafe-eval'`.
  plugins: [react(), wasm(), topLevelAwait()],
  optimizeDeps: { exclude: ['chia-wallet-sdk-wasm', '@dignetwork/chip35-dl-coin-wasm'] },
  define: {
    // App semver baked into the JS bundle for window.__APP_VERSION__ + footer (§6.7). The HTML
    // <meta name="app-version"> placeholder is replaced separately by build.js at copy time.
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    alias: {
      '@': resolve(rootDir, 'src'),
      '#shared': rootDir,
    },
  },
  build: {
    outDir: 'dist-web',
    emptyOutDir: true,
    // Never inline assets as data: URIs — the extension_pages CSP is strict; keep everything
    // as `'self'` files.
    assetsInlineLimit: 0,
    target: 'chrome111',
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: {
        popup: resolve(rootDir, 'popup.html'),
        app: resolve(rootDir, 'app.html'),
        // The offscreen keystore vault document (#56) — created by the SW via chrome.offscreen.
        offscreen: resolve(rootDir, 'offscreen.html'),
        // The dApp approval window (#56 §5.5) — summoned by the SW via chrome.windows.create.
        approval: resolve(rootDir, 'approval.html'),
        // First-run welcome page (opened by the SW's onInstalled) — a vanilla-TS extension page
        // (no React), built by Vite so its TS entry can import the shared #shared/* modules.
        welcome: resolve(rootDir, 'welcome.html'),
        // DIG settings (options_ui) — vanilla-TS extension page, same rationale as welcome.
        options: resolve(rootDir, 'options.html'),
        // DIG Viewer (chia:// content render) — the SW redirects chia:// navigations to it via
        // getURL('dig-viewer.html'). A vanilla-TS extension page (no React), built by Vite so its
        // TS entry can import the shared #shared/* view-models (error-page / messages / dig-urn /
        // error-codes / store-refs) it renders + bridges with.
        digViewer: resolve(rootDir, 'dig-viewer.html'),
        // DIG Home (new-tab override) — vanilla-TS extension page, same rationale as welcome.
        newtab: resolve(rootDir, 'newtab.html'),
      },
    },
  },
});
