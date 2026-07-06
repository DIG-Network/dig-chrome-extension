/**
 * Tests for the catalogued chia:// loader error codes (error-codes.mjs).
 *
 * Every resolver/viewer failure path must carry a STABLE, machine-readable UPPER_SNAKE
 * code (not just human prose), so an agent can branch on the failure kind. The four
 * canonical `dig-loader` codes are owned by docs.dig.net's static/error-codes.json — this
 * module must stay byte-aligned with that surface (see ../../SYSTEM.md cross-surface catalog).
 *
 * Run: node --test tests/
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  DIG_ERR,
  DIG_LOADER_CODES,
  ERROR_CATALOGUE,
  classifyError,
  makeError,
} from '@/lib/error-codes';

test('DIG_ERR is a frozen enum of UPPER_SNAKE codes', () => {
  assert.ok(Object.isFrozen(DIG_ERR), 'DIG_ERR must be frozen');
  for (const [key, val] of Object.entries(DIG_ERR)) {
    assert.equal(key, val, `${key} must map to its own string value (${val})`);
    assert.match(val, /^DIG_ERR_[A-Z0-9_]+$/, `${val} must be UPPER_SNAKE with DIG_ERR_ prefix`);
  }
});

test('the four canonical dig-loader codes match docs.dig.net error-codes.json exactly', () => {
  // These four are the cross-surface contract (docs static/error-codes.json → dig-loader).
  // The extension MUST surface these exact spellings; agents branch on them across modules.
  const canonical = [
    'DIG_ERR_PROOF_MISMATCH',
    'DIG_ERR_DECRYPT_TAG',
    'DIG_ERR_NOT_FOUND',
    'DIG_ERR_NETWORK',
  ];
  for (const code of canonical) {
    assert.equal((DIG_ERR as Record<string, string>)[code], code, `${code} must exist in DIG_ERR`);
    assert.ok((DIG_LOADER_CODES as readonly string[]).includes(code), `${code} must be in DIG_LOADER_CODES`);
  }
  // DIG_LOADER_CODES is exactly the canonical four (the cross-surface subset) — extension-only
  // codes (INVALID_URN, DIGNODE_REQUIRED) live in DIG_ERR but are NOT part of the shared surface.
  assert.deepEqual([...DIG_LOADER_CODES].sort(), [...canonical].sort());
});

test('ERROR_CATALOGUE documents every DIG_ERR code with a message', () => {
  for (const code of Object.values(DIG_ERR)) {
    const entry = ERROR_CATALOGUE.find((e) => e.code === code);
    assert.ok(entry, `${code} must have a catalogue entry`);
    assert.equal(typeof entry.message, 'string');
    assert.ok(entry.message.length > 0, `${code} must have a non-empty message`);
    assert.equal(typeof entry.canonical, 'boolean', `${code} must mark whether it is canonical`);
  }
});

test('classifyError maps a network failure to DIG_ERR_NETWORK', () => {
  assert.equal(classifyError('Could not reach the content network. Check your connection.'), DIG_ERR.DIG_ERR_NETWORK);
  assert.equal(classifyError('Failed to fetch'), DIG_ERR.DIG_ERR_NETWORK);
  assert.equal(classifyError('dig RPC HTTP error 503'), DIG_ERR.DIG_ERR_NETWORK);
});

test('classifyError maps a decrypt-tag failure to DIG_ERR_DECRYPT_TAG', () => {
  assert.equal(classifyError('decrypt failed (decoy or wrong key)'), DIG_ERR.DIG_ERR_DECRYPT_TAG);
});

test('classifyError maps a proof/verification failure to DIG_ERR_PROOF_MISMATCH', () => {
  assert.equal(classifyError('inclusion proof did not verify'), DIG_ERR.DIG_ERR_PROOF_MISMATCH);
  assert.equal(classifyError('served ciphertext length does not match chunk lengths'), DIG_ERR.DIG_ERR_PROOF_MISMATCH);
});

test('classifyError maps an invalid URN to DIG_ERR_INVALID_URN', () => {
  assert.equal(classifyError('Invalid URN format'), DIG_ERR.DIG_ERR_INVALID_URN);
  assert.equal(classifyError('Invalid chia:// URL'), DIG_ERR.DIG_ERR_INVALID_URN);
});

test('classifyError maps a dig-node-required failure to DIG_ERR_DIGNODE_REQUIRED', () => {
  assert.equal(classifyError('ECONNREFUSED localhost:8080'), DIG_ERR.DIG_ERR_DIGNODE_REQUIRED);
  assert.equal(classifyError('dig-node not running'), DIG_ERR.DIG_ERR_DIGNODE_REQUIRED);
});

test('classifyError falls back to DIG_ERR_NETWORK for an unknown message', () => {
  // A failure we cannot classify is treated as a transport/availability problem (fail-safe,
  // recoverable) rather than inventing a discriminant — but it is still a stable code.
  assert.equal(classifyError('something totally unexpected'), DIG_ERR.DIG_ERR_NETWORK);
});

test('classifyError accepts an Error object (reads .code then .message)', () => {
  const e = new Error('Invalid URN format');
  assert.equal(classifyError(e), DIG_ERR.DIG_ERR_INVALID_URN);
  const tagged = new Error('whatever');
  (tagged as { code?: string }).code = DIG_ERR.DIG_ERR_DECRYPT_TAG; // an already-coded error keeps its code
  assert.equal(classifyError(tagged), DIG_ERR.DIG_ERR_DECRYPT_TAG);
});

test('makeError returns a stable {success:false, code, message} envelope', () => {
  const env = makeError('decrypt failed (decoy or wrong key)');
  assert.equal(env.success, false);
  assert.equal(env.code, DIG_ERR.DIG_ERR_DECRYPT_TAG);
  assert.equal(typeof env.message, 'string');
  assert.ok(env.message.length > 0);
});

test('makeError preserves an explicit code override', () => {
  const env = makeError('boom', DIG_ERR.DIG_ERR_NOT_FOUND);
  assert.equal(env.code, DIG_ERR.DIG_ERR_NOT_FOUND);
});

test('makeError keeps the human message for humans (does not replace it with the code)', () => {
  const env = makeError('Could not reach the content network. Check your connection.');
  assert.equal(env.message, 'Could not reach the content network. Check your connection.');
});
