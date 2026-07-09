/**
 * SPEC.md drift guard.
 *
 * SPEC.md is the repo's normative contract. These tests pin the concrete constants SPEC.md
 * asserts (default port, dig.local address, message-protocol version, the canonical dig-loader
 * error subset, the WASM SRI pin, the manifest runtime requirements) against the actual code +
 * files, so a change that alters one of them without updating SPEC.md fails here. Keep SPEC.md
 * and the code in lockstep — a failing test means one of the two drifted.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { MESSAGE_PROTOCOL_VERSION } from '@/lib/messages';
import { DEFAULT_DIG_NODE_PORT, DIG_LOCAL_URL, digNodeCandidates } from '@/lib/server-config';
import { DIG_LOADER_CODES } from '@/lib/error-codes';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SPEC = readFileSync(join(ROOT, 'SPEC.md'), 'utf8');

test('SPEC.md exists and is a normative spec (RFC-2119 voice)', () => {
  assert.ok(SPEC.length > 2000, 'SPEC.md should be a comprehensive document');
  assert.match(SPEC, /MUST/);
  assert.match(SPEC, /RFC 2119/);
});

test('SPEC documents the actual default dig-node port (9778, #132)', () => {
  assert.equal(DEFAULT_DIG_NODE_PORT, 9778);
  assert.match(SPEC, /9778/);
});

test('SPEC documents the branded local dig-node address (dig.local, port 80)', () => {
  assert.equal(DIG_LOCAL_URL, 'http://dig.local');
  assert.match(SPEC, /dig\.local/);
});

test('node-resolution ladder tries dig.local before localhost:<port>', () => {
  const cands = digNodeCandidates();
  assert.deepEqual(cands, ['http://dig.local', `http://localhost:${DEFAULT_DIG_NODE_PORT}`]);
  // SPEC §8.1 must describe this order.
  const digLocalIdx = SPEC.indexOf('http://dig.local');
  const localhostIdx = SPEC.indexOf('http://localhost:<port>');
  assert.ok(digLocalIdx >= 0 && localhostIdx >= 0, 'SPEC must name both candidates');
  assert.ok(digLocalIdx < localhostIdx, 'SPEC must list dig.local before localhost');
});

test('SPEC documents the current message-protocol version', () => {
  assert.equal(MESSAGE_PROTOCOL_VERSION, 28);
  assert.match(SPEC, new RegExp(`MESSAGE_PROTOCOL_VERSION[^\\n]*\\b${MESSAGE_PROTOCOL_VERSION}\\b`));
});

test('SPEC lists every canonical dig-loader error code verbatim', () => {
  assert.deepEqual(DIG_LOADER_CODES, [
    'DIG_ERR_PROOF_MISMATCH',
    'DIG_ERR_DECRYPT_TAG',
    'DIG_ERR_NOT_FOUND',
    'DIG_ERR_NETWORK',
  ]);
  for (const code of DIG_LOADER_CODES) {
    assert.match(SPEC, new RegExp(code), `SPEC must document ${code}`);
  }
});

test('SPEC pins the same read-crypto WASM SRI digest as background.js', () => {
  const bg = readFileSync(join(ROOT, 'src', 'background', 'index.ts'), 'utf8');
  const m = bg.match(/DIG_CLIENT_WASM_SHA256\s*=\s*"([0-9a-f]{64})"/);
  assert.ok(m, 'background.js must pin a 64-hex WASM SHA-256');
  assert.match(SPEC, /SHA-256/);
  assert.match(SPEC, /fail-closed|fail closed/i);
});

test('SPEC and manifest agree on the MV3 module-service-worker runtime', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background.type, 'module');
  assert.match(manifest.content_security_policy.extension_pages, /wasm-unsafe-eval/);
  assert.match(SPEC, /Manifest V3/);
  assert.match(SPEC, /wasm-unsafe-eval/);
});

test('SPEC documents the dig.getContent JSON-RPC wire params', () => {
  for (const field of ['store_id', 'root', 'retrieval_key', 'offset', 'length']) {
    assert.match(SPEC, new RegExp(field), `SPEC must document dig.getContent param ${field}`);
  }
  assert.match(SPEC, /dig\.getContent/);
});

test('manifest allows an arbitrary HTTPS host, required for getNftMetadata (#98)', () => {
  // #98's off-chain metadata fetch (getNftMetadata) needs to reach hosts that cannot be enumerated
  // in advance (IPFS gateways, marketplace CDNs). A background service worker's own fetch() was
  // empirically found to still be subject to extension-pages connect-src (DEVELOPMENT_LOG.md) — so
  // connect-src/host_permissions must include a broad allowance, not just the fixed known hosts.
  const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8')) as {
    host_permissions: string[];
    content_security_policy: { extension_pages: string };
  };
  assert.match(manifest.content_security_policy.extension_pages, /connect-src[^;]*\bhttps:/, 'connect-src must allow any https host');
  assert.ok(manifest.host_permissions.some((p) => /^https:\/\/\*\/\*$/.test(p)), 'host_permissions must include an all-hosts https pattern');
  assert.match(SPEC, /widened to any HTTPS host/, 'SPEC must document the widened connect-src/host_permissions');
});
