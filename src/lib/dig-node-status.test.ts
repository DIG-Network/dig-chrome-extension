/**
 * Tests for the dig-node install prompt + error mapping (dig-node-status.mjs).
 *
 * When the local dig-node is NOT reachable, the extension surfaces a clear, plain-language
 * prompt telling the user to install it, linking to the universal installer. A small set of
 * failures are "dig-node required" (the user pointed the extension at a local node that isn't
 * running) — those map to the install prompt rather than the generic network error.
 *
 * Run: node --test tests/
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  DIG_INSTALLER_URL,
  digNodeInstallPrompt,
  isDigNodeRequiredError,
} from '@/lib/dig-node-status';

test('DIG_INSTALLER_URL points at the universal installer releases page', () => {
  assert.equal(DIG_INSTALLER_URL, 'https://github.com/DIG-Network/dig-installer/releases');
});

test('digNodeInstallPrompt is friendly, plain-language, and names dig-node + the installer', () => {
  const p = digNodeInstallPrompt();
  assert.equal(typeof p.title, 'string');
  assert.equal(typeof p.body, 'string');
  assert.equal(p.installUrl, DIG_INSTALLER_URL);
  assert.match(p.body, /dig-node/i, 'should name the dig-node');
  assert.match(p.title + ' ' + p.body, /install/i, 'should tell the user to install it');
  // Plain language — no protocol jargon leaking into the default copy.
  assert.ok(!/retrieval[_\s-]?key|merkle|singleton|CHIP-?0035/i.test(p.title + ' ' + p.body));
});

test('digNodeInstallPrompt label is a short call-to-action for the link', () => {
  const p = digNodeInstallPrompt();
  assert.equal(typeof p.installLabel, 'string');
  assert.ok(p.installLabel.length > 0 && p.installLabel.length < 40);
  assert.match(p.installLabel, /install/i);
});

test('isDigNodeRequiredError is true for a local-node connection failure', () => {
  assert.equal(isDigNodeRequiredError('dig-node not running'), true);
  assert.equal(isDigNodeRequiredError('local node unreachable'), true);
  assert.equal(isDigNodeRequiredError('ECONNREFUSED 127.0.0.1:8080'), true);
  assert.equal(isDigNodeRequiredError('Failed to fetch http://localhost:8080/'), true);
  assert.equal(isDigNodeRequiredError('ENOTFOUND dig.local'), true);
});

test('isDigNodeRequiredError is false for an unrelated failure', () => {
  assert.equal(isDigNodeRequiredError('dig RPC HTTP error 500'), false);
  assert.equal(isDigNodeRequiredError('Invalid URN format'), false);
  assert.equal(isDigNodeRequiredError(''), false);
  assert.equal(isDigNodeRequiredError(null), false);
});
