#!/usr/bin/env node
/**
 * Supply-chain lockdown enforcer (#67 P0-1a) — our own minimal allow-scripts, no third-party
 * (LavaMoat / Ethereum) tooling.
 *
 * `.npmrc` sets `ignore-scripts=true`, so `npm ci` runs NO dependency lifecycle script. That closes
 * the biggest catastrophic-loss vector for a hot wallet: a malicious/typo-squatted dep whose
 * `postinstall` exfiltrates the seed at install time, in the same realm as the key-holding offscreen
 * bundle. This script then:
 *
 *   1. Scans the installed dependency tree for every package that ships a preinstall/install/
 *      postinstall script.
 *   2. FAILS (exit 1) if any such package is NOT in `allowed-install-scripts.json` — a drift gate,
 *      so a newly-introduced script-bearing dependency cannot land without a reviewed allowlist
 *      entry.
 *   3. (default mode) Re-runs the install scripts of the ALLOWLISTED packages via `npm rebuild`,
 *      restoring the few genuinely-needed native/platform-binary setups (e.g. esbuild).
 *
 * Usage:
 *   node scripts/allow-scripts.mjs           # check drift, then rebuild the allowlisted packages
 *   node scripts/allow-scripts.mjs --check   # check drift ONLY (the CI/test gate — no rebuild)
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LIFECYCLE = ['preinstall', 'install', 'postinstall'];
const checkOnly = process.argv.includes('--check');

/** The reviewed set of packages permitted to run install scripts. */
function loadAllowlist() {
  const raw = JSON.parse(readFileSync(join(ROOT, 'allowed-install-scripts.json'), 'utf8'));
  return new Set(raw.allow ?? []);
}

/** Every installed package (name → hooks[]) that ships an install lifecycle script. */
function scanInstallScripts(nodeModules) {
  const found = new Map();
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name === '.bin') continue;
      const full = join(dir, e.name);
      if (e.name.startsWith('@')) {
        walk(full); // scope dir — descend into its packages
        continue;
      }
      const pj = join(full, 'package.json');
      if (existsSync(pj)) {
        try {
          const p = JSON.parse(readFileSync(pj, 'utf8'));
          const hooks = LIFECYCLE.filter((h) => p.scripts?.[h]);
          if (hooks.length && p.name) {
            const prev = found.get(p.name) ?? new Set();
            hooks.forEach((h) => prev.add(h));
            found.set(p.name, prev);
          }
        } catch {
          /* unreadable package.json — ignore */
        }
      }
      const nested = join(full, 'node_modules');
      if (existsSync(nested)) walk(nested);
    }
  };
  walk(nodeModules);
  return found;
}

function main() {
  const nodeModules = join(ROOT, 'node_modules');
  if (!existsSync(nodeModules)) {
    console.error('allow-scripts: node_modules not found — run `npm ci` first.');
    process.exit(1);
  }
  const allow = loadAllowlist();
  const scripted = scanInstallScripts(nodeModules);

  // Drift gate: any script-bearing package not on the allowlist is a supply-chain review event.
  const unexpected = [...scripted.keys()].filter((name) => !allow.has(name)).sort();
  if (unexpected.length) {
    console.error('\n✗ Supply-chain gate: unlisted dependencies ship install scripts:\n');
    for (const name of unexpected) console.error(`    ${name}  (${[...scripted.get(name)].join(', ')})`);
    console.error(
      '\n  These run at install time with full authority. Review each, then either remove the dependency\n' +
        '  or add it to allowed-install-scripts.json. NEVER allowlist a package you have not audited.\n',
    );
    process.exit(1);
  }

  const toRebuild = [...allow].filter((name) => scripted.has(name)).sort();
  console.log(
    `✓ Supply-chain gate: ${scripted.size} package(s) ship install scripts, all allowlisted` +
      (toRebuild.length ? ` (${toRebuild.join(', ')}).` : '.'),
  );

  if (checkOnly) return;

  // Re-run the trusted allowlisted install scripts (native/platform-binary setup).
  for (const name of toRebuild) {
    console.log(`  → npm rebuild ${name}`);
    execFileSync('npm', ['rebuild', name, '--foreground-scripts'], {
      cwd: ROOT,
      stdio: 'inherit',
      shell: process.platform === 'win32', // npm is a .cmd shim on Windows
    });
  }
}

main();
