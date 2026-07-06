import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify('0.0.0-test'),
  },
  resolve: {
    alias: {
      '@': resolve(rootDir, 'src'),
      '#shared': rootDir,
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
    coverage: {
      provider: 'v8',
      all: true,
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'src/**/*.d.ts',
        'src/types/**',
        // Entry glue: DOM mounting + service-worker-adjacent wiring — no meaningful branches.
        'src/entries/**',
        // The MV3 module service worker (#68): behaviour-frozen chrome.* runtime glue, validated by
        // the browser SW-registration harness (e2e/sw/), not jsdom unit tests — same rationale as
        // src/content/**. (@ts-nocheck infra; not unit-testable without a browser.)
        'src/background/**',
        // Content-script interception shims (#68): MAIN/isolated-world DOM-glue that reassigns
        // native URL-consuming globals. Not unit-testable in jsdom — validated by build.js bundle
        // guards, the tests/*.test.mjs source assertions, and e2e; same rationale as entries/.
        'src/content/**',
        // Locale message tables (data, not logic).
        'src/i18n/messages/**',
        // Test-only helpers (render harness, mock transport).
        'src/test/**',
      ],
      reporter: ['text', 'text-summary'],
      thresholds: {
        lines: 80,
        branches: 80,
        functions: 80,
        statements: 80,
      },
    },
  },
});
