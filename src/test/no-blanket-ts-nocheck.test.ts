/**
 * Carve-out regression guard (#1464).
 *
 * The MV3 service-worker monolith `src/background/index.ts` is behaviour-frozen chrome.* glue that
 * carries a justified file-level `// @ts-nocheck` + a matching eslint carve-out (#68). That carve-out
 * used to be `src/background/**` — which silently swallowed NEW handler modules added beside the
 * monolith, letting them ship without tsc/eslint. #1464 pinned the carve-out to the ONE frozen file.
 *
 * This suite is the CI trip-wire that stops the carve-out from silently re-widening:
 *   1. `index.ts` is the ONLY file under src/background/ allowed a blanket `@ts-nocheck`.
 *   2. The eslint config's background carve-out targets exactly `src/background/index.ts` — not a
 *      `src/background/**` / `*` glob that would re-swallow new files.
 *
 * A new SW handler therefore MUST be a fully-typed sibling module (like `app-sign-handlers.ts`), not
 * more untyped code hidden under the frozen file's suppression.
 *
 * Run: node --test tests/  (and vitest)
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FROZEN_FILE = 'index.ts';

/** A file-level `@ts-nocheck` (a leading-comment suppression that disables ALL type-checking). */
const BLANKET_TS_NOCHECK = /^\s*\/\/\s*@ts-nocheck/m;

test('only the frozen SW monolith (index.ts) may carry a blanket @ts-nocheck', () => {
  const dir = join(ROOT, 'src', 'background');
  const offenders = readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .filter((f) => f !== FROZEN_FILE)
    .filter((f) => BLANKET_TS_NOCHECK.test(readFileSync(join(dir, f), 'utf8')));

  assert.deepEqual(
    offenders,
    [],
    `New src/background files must be fully typed — no blanket @ts-nocheck. Offenders: ${offenders.join(', ')}. ` +
      `Extract new handlers into a typed sibling module (see app-sign-handlers.ts), do not hide them under the frozen carve-out.`,
  );
});

test('the eslint background carve-out is pinned to the single frozen file, not a wildcard', () => {
  const config = readFileSync(join(ROOT, 'eslint.config.mjs'), 'utf8');
  assert.ok(
    config.includes("files: ['src/background/index.ts']"),
    "eslint.config.mjs must carve out exactly ['src/background/index.ts']",
  );
  assert.ok(
    !/files:\s*\[\s*['"]src\/background\/\*/.test(config),
    'eslint.config.mjs must NOT carve out a src/background/* wildcard (it would re-swallow new files)',
  );
});
