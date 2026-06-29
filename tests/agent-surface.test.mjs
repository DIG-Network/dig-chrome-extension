/**
 * Tests for the machine-readable agent-surface index (agent-surface.mjs).
 *
 * One self-describing JSON artifact an agent can read to learn the whole extension contract
 * — message protocol version, the ACTIONS list, the wallet method surface, the error-code
 * catalogue, and the injected-provider surface — generated from the SAME source modules the
 * runtime uses (so it can't drift). Emitted into dist/ at build time and served as a
 * web_accessible_resource.
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentSurface } from '../agent-surface.mjs';
import { ACTIONS } from '../messages.mjs';
import { DIG_ERR } from '../error-codes.mjs';
import { WALLET_METHODS } from '../wallet-methods.mjs';

test('buildAgentSurface emits a versioned, self-describing object', () => {
  const s = buildAgentSurface('1.1.0');
  assert.equal(s.name, 'dig-chrome-extension');
  assert.equal(s.version, '1.1.0');
  assert.equal(typeof s.messageProtocol, 'number');
  assert.ok(s.generatedFrom, 'should declare its source of truth');
});

test('agent-surface carries the full action list (from messages.mjs)', () => {
  const s = buildAgentSurface('1.1.0');
  assert.deepEqual([...s.actions].sort(), [...Object.values(ACTIONS)].sort());
});

test('agent-surface carries the wallet method surface (from wallet-methods.mjs)', () => {
  const s = buildAgentSurface('1.1.0');
  assert.deepEqual([...s.walletMethods].sort(), [...WALLET_METHODS].sort());
});

test('agent-surface carries the error-code catalogue (from error-codes.mjs)', () => {
  const s = buildAgentSurface('1.1.0');
  const codes = s.errorCodes.map((e) => e.code);
  for (const c of Object.values(DIG_ERR)) assert.ok(codes.includes(c), `missing ${c}`);
  // Each entry documents whether it is part of the shared cross-surface dig-loader subset.
  for (const e of s.errorCodes) assert.equal(typeof e.canonical, 'boolean');
});

test('agent-surface describes the injected provider (version, info, methods, error codes)', () => {
  const s = buildAgentSurface('1.1.0');
  assert.ok(s.provider, 'should describe window.chia');
  assert.equal(s.provider.info.edition, 'extension');
  assert.deepEqual([...s.provider.methods].sort(), [...WALLET_METHODS].sort());
  assert.equal(s.provider.errorCodes.USER_REJECTED, 4001);
});

test('agent-surface links the cross-surface error catalog + dig RPC spec', () => {
  const s = buildAgentSurface('1.1.0');
  assert.match(JSON.stringify(s.machineReadable), /error-codes\.json/);
  assert.match(JSON.stringify(s.machineReadable), /docs\.dig\.net/);
});

test('agent-surface is JSON-serialisable (no functions / cycles)', () => {
  const s = buildAgentSurface('1.1.0');
  const round = JSON.parse(JSON.stringify(s));
  assert.deepEqual(round.actions, s.actions);
});
