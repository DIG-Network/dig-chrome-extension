/**
 * Tests for the shared dig-node host config (server-config.mjs).
 *
 * Before unification, three surfaces disagreed on the SAME storage key `server.host`:
 *   - the old vanilla popup → "RPC Host", default `localhost:80`
 *   - options.js → "Companion host", default `localhost:8080`
 *   - background → getServerConfig fallback defaulted to port 80
 * This module is the single source of truth: ONE name (the dig-node host), ONE default
 * (`localhost:8080`, the dig-node port — renamed from dig-companion), and ONE parser so a
 * value typed on one surface is read identically everywhere.
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  DEFAULT_DIG_NODE_HOST,
  DEFAULT_DIG_NODE_PORT,
  parseServerHost,
  formatServerHost,
} from '../server-config.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('default dig-node host is localhost:8080 (the dig-node port)', () => {
  assert.equal(DEFAULT_DIG_NODE_HOST, 'localhost:8080');
  assert.equal(DEFAULT_DIG_NODE_PORT, 8080);
});

test('empty/blank input falls back to the default dig-node host:port', () => {
  for (const input of ['', '   ', null, undefined]) {
    assert.deepEqual(parseServerHost(input), { url: 'localhost', port: 8080 });
  }
});

test('parses host:port', () => {
  assert.deepEqual(parseServerHost('localhost:8080'), { url: 'localhost', port: 8080 });
  assert.deepEqual(parseServerHost('127.0.0.1:9777'), { url: '127.0.0.1', port: 9777 });
});

test('host without a port uses the default dig-node port (8080, NOT 80)', () => {
  assert.deepEqual(parseServerHost('localhost'), { url: 'localhost', port: 8080 });
  assert.deepEqual(parseServerHost('my-node.local'), { url: 'my-node.local', port: 8080 });
});

test('strips an http(s):// scheme prefix', () => {
  assert.deepEqual(parseServerHost('http://localhost:8080'), { url: 'localhost', port: 8080 });
  assert.deepEqual(parseServerHost('https://node:443'), { url: 'node', port: 443 });
});

test('out-of-range port falls back to the default dig-node port', () => {
  assert.deepEqual(parseServerHost('localhost:0'), { url: 'localhost', port: 8080 });
  assert.deepEqual(parseServerHost('localhost:70000'), { url: 'localhost', port: 8080 });
});

test('formatServerHost renders url:port', () => {
  assert.equal(formatServerHost('localhost', 8080), 'localhost:8080');
});

test('round-trips parse → format', () => {
  const { url, port } = parseServerHost('localhost:8080');
  assert.equal(formatServerHost(url, port), 'localhost:8080');
});

// ---- Port-default unification (#43 / #41 audit) --------------------------------------------
//
// REGRESSION: middleware.js and content.js are classic (non-module) content scripts and can't
// `import` DEFAULT_DIG_NODE_PORT from this module, so they carried their OWN hardcoded literal
// default of `localhost:80` (the http-standard port) — disagreeing with the dig-node's actual
// default port 8080 used everywhere else (background.js, options.js, this module). Fixed by
// updating the literals to `8080`; this test pins the source text so it can't silently drift
// back to `:80`.
test('middleware.js and content.js default the RPC host to the dig-node port (8080, not 80)', () => {
  for (const file of ['middleware.js', 'content.js']) {
    const src = readFileSync(join(ROOT, file), 'utf8');
    assert.ok(!/localhost:80['"`]/.test(src), `${file} must not default to the stale localhost:80`);
    assert.match(src, /localhost:8080/, `${file} must default to localhost:8080 (the dig-node port)`);
  }
});
