// Flat ESLint config, scoped to the new React/TypeScript surface (src/). The legacy vanilla-JS
// modules (background.js, content.js, the .mjs view-models, build.js) are covered by their own
// `node --test` suite and are intentionally out of this lint scope for Phase 0 — this gate is a
// ZERO-error bar for the React wallet shell (CLAUDE.md §6.4).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import testingLibrary from 'eslint-plugin-testing-library';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist/**', 'dist-web/**', 'coverage/**', 'node_modules/**', 'vendor/**'] },
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, chrome: 'readonly', __APP_VERSION__: 'readonly' },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    // Test files may use a few looser patterns (non-null in fixtures, etc.), and are held to the
    // Testing-Library async-query discipline (#489): ban a sync `getBy*` after an async action (the
    // #488 flaky-render class) — `prefer-find-by` steers `waitFor(() => getBy*)` to `findBy*`,
    // `await-async-queries` forces awaiting `findBy*`, and `no-await-sync-queries` bans awaiting a
    // sync query. Zero-error gate.
    files: ['src/**/*.test.{ts,tsx}'],
    plugins: { 'testing-library': testingLibrary },
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      'testing-library/prefer-find-by': 'error',
      'testing-library/await-async-queries': 'error',
      'testing-library/no-await-sync-queries': 'error',
    },
  },
  {
    // The two large content-script interception shims (#68): verbatim-moved MAIN/isolated-world
    // code whose whole job is reassigning native URL-consuming globals — untypeable by TS's DOM
    // types and behaviour-frozen (relocated unchanged). They carry `// @ts-nocheck` and are held
    // to the same infra-vs-React-shell bar this repo already applied to the legacy vanilla modules.
    // The sibling middleware.ts is NOT listed here — it stays fully typed under the strict bar.
    files: ['src/content/content.ts', 'src/content/page-script.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      'no-useless-escape': 'off',
      'prefer-const': 'off',
    },
  },
  {
    // The MV3 module service worker (#68): ~2.7k lines of behaviour-frozen chrome.* runtime glue
    // RELOCATED verbatim from the old root background.js (a MOVE, not a rewrite). Same infra-vs-
    // React-shell bar as the content shims above — it carries `// @ts-nocheck` and is validated by
    // the browser SW-registration harness (e2e/sw/), not the strict React-shell lint bar.
    files: ['src/background/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      'no-useless-escape': 'off',
      'prefer-const': 'off',
    },
  },
);
