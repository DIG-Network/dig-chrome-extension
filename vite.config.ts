import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
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
  plugins: [react()],
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
      },
    },
  },
});
