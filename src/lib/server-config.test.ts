/**
 * Tests for the shared dig-node host config (server-config.mjs).
 *
 * Before unification, three surfaces disagreed on the SAME storage key `server.host`:
 *   - the old vanilla popup → "RPC Host", default `localhost:80`
 *   - options.js → "Companion host", default `localhost:8080`
 *   - background → getServerConfig fallback defaulted to port 80
 * This module is the single source of truth: ONE name (the dig-node host), ONE default
 * (`localhost:9778`, the canonical dig-node control port — see #132; renamed from dig-companion's
 * old 8080), and ONE parser so a value typed on one surface is read identically everywhere.
 *
 * Run: node --test tests/
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  DEFAULT_DIG_NODE_HOST,
  DEFAULT_DIG_NODE_PORT,
  parseServerHost,
  formatServerHost,
} from '@/lib/server-config';

// This test lives at src/lib/, so the repo root is two levels up.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('default dig-node host is localhost:9778 (the canonical dig-node control port, #132)', () => {
  assert.equal(DEFAULT_DIG_NODE_HOST, 'localhost:9778');
  assert.equal(DEFAULT_DIG_NODE_PORT, 9778);
});

test('empty/blank input falls back to the default dig-node host:port', () => {
  for (const input of ['', '   ', null, undefined]) {
    assert.deepEqual(parseServerHost(input), { url: 'localhost', port: 9778 });
  }
});

test('parses host:port', () => {
  assert.deepEqual(parseServerHost('localhost:9778'), { url: 'localhost', port: 9778 });
  assert.deepEqual(parseServerHost('127.0.0.1:9777'), { url: '127.0.0.1', port: 9777 });
});

test('host without a port uses the default dig-node port (9778, NOT 80)', () => {
  assert.deepEqual(parseServerHost('localhost'), { url: 'localhost', port: 9778 });
  assert.deepEqual(parseServerHost('my-node.local'), { url: 'my-node.local', port: 9778 });
});

test('strips an http(s):// scheme prefix', () => {
  assert.deepEqual(parseServerHost('http://localhost:9778'), { url: 'localhost', port: 9778 });
  assert.deepEqual(parseServerHost('https://node:443'), { url: 'node', port: 443 });
});

test('out-of-range port falls back to the default dig-node port', () => {
  assert.deepEqual(parseServerHost('localhost:0'), { url: 'localhost', port: 9778 });
  assert.deepEqual(parseServerHost('localhost:70000'), { url: 'localhost', port: 9778 });
});

test('formatServerHost renders url:port', () => {
  assert.equal(formatServerHost('localhost', 9778), 'localhost:9778');
});

test('round-trips parse → format', () => {
  const { url, port } = parseServerHost('localhost:9778');
  assert.equal(formatServerHost(url, port), 'localhost:9778');
});

// ---- Port-default unification (#43 / #41 audit; #132 canonical-port migration) --------------
//
// REGRESSION: middleware.js and content.js are classic (non-module) content scripts and can't
// `import` DEFAULT_DIG_NODE_PORT from this module, so they carried their OWN hardcoded literal
// default. This test pins the source text so it can't silently drift from the shared constant —
// first `:80` (the http-standard port, #43/#41), now the retired `:8080` (#132: the canonical
// dig-node control port moved to 9778, sibling of dig-wallet's 9777).
test('middleware.js and content.js default the RPC host to the canonical dig-node port (9778)', () => {
  for (const file of ['src/content/middleware.ts', 'src/content/content.ts']) {
    const src = readFileSync(join(ROOT, file), 'utf8');
    assert.ok(!/localhost:80['"`]/.test(src), `${file} must not default to the stale localhost:80`);
    assert.ok(!/localhost:8080['"`]/.test(src), `${file} must not default to the retired localhost:8080`);
    assert.match(src, /localhost:9778/, `${file} must default to localhost:9778 (the canonical dig-node port)`);
  }
});
