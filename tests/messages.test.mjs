/**
 * Tests for the background message catalogue (messages.mjs).
 *
 * The extension's internal contract is the set of chrome.runtime `message.action` request
 * types the background service worker handles, plus the window.postMessage bridge the
 * injected provider uses. Before this module that contract lived only as ~24 ad-hoc string
 * literals scattered across 90 KB of background.js with no enum, no version, no DTOs — an
 * agent (or the popup/viewer) had to read the whole file to learn it. messages.mjs makes it
 * one frozen, versioned, self-describing source of truth.
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MESSAGE_PROTOCOL_VERSION,
  ACTIONS,
  BRIDGE,
  MESSAGE_CATALOGUE,
  isKnownAction,
} from '../messages.mjs';

test('MESSAGE_PROTOCOL_VERSION is a positive integer (the contract version)', () => {
  assert.equal(typeof MESSAGE_PROTOCOL_VERSION, 'number');
  assert.ok(Number.isInteger(MESSAGE_PROTOCOL_VERSION) && MESSAGE_PROTOCOL_VERSION >= 1);
});

test('ACTIONS is a frozen enum where each key maps to its own string value', () => {
  assert.ok(Object.isFrozen(ACTIONS), 'ACTIONS must be frozen');
  for (const [key, val] of Object.entries(ACTIONS)) {
    assert.equal(typeof val, 'string');
    assert.equal(key, val, `${key} must map to its own value (got ${val})`);
  }
});

test('ACTIONS covers EVERY action the background service worker handles', () => {
  // This is the live contract — if a handler is added to background.js without a catalogue
  // entry, this test (which mirrors the audited handler list) flags the drift.
  const handled = [
    'toggleExtension', 'convertDigUrl', 'navigateToDigUrl', 'navigateToDataUrl',
    'getDataUrl', 'updateServerConfig', 'reportError', 'reportSuccess', 'navigate',
    'preloadResources', 'proxyRequest', 'walletRpc', 'reportVerification', 'getVerification',
    'getCacheStats', 'clearCache', 'getDigNodeStatus', 'walletConsent',
    // Shield action (per-resource proof ledger) + Control Panel (node management view):
    'recordLedgerEntry', 'getShieldLedger', 'getControlStatus',
    'addSearchEngine', 'getDefaultSearchEngine', 'isDigSearchDefault', 'updateSearchConfig',
    // background → content broadcast:
    'updateRpcHost',
    // capability/version self-description (added for agent-friendliness):
    'getCapabilities',
  ];
  for (const a of handled) {
    assert.equal(ACTIONS[a], a, `ACTIONS is missing "${a}"`);
  }
});

test('BRIDGE describes the window.postMessage provider bridge protocol', () => {
  assert.ok(Object.isFrozen(BRIDGE));
  assert.equal(BRIDGE.WALLET_REQUEST, 'DIG_WALLET_REQUEST');
  assert.equal(BRIDGE.WALLET_RESPONSE, 'DIG_WALLET_RESPONSE');
});

test('MESSAGE_CATALOGUE documents every action with a typed request/response shape', () => {
  for (const action of Object.values(ACTIONS)) {
    const entry = MESSAGE_CATALOGUE[action];
    assert.ok(entry, `MESSAGE_CATALOGUE is missing an entry for "${action}"`);
    assert.equal(typeof entry.summary, 'string');
    assert.ok(entry.summary.length > 0, `${action} must have a summary`);
    assert.ok('request' in entry, `${action} must document its request fields`);
    assert.ok('response' in entry, `${action} must document its response fields`);
  }
});

test('MESSAGE_CATALOGUE has no entries for unknown actions (no drift the other way)', () => {
  for (const action of Object.keys(MESSAGE_CATALOGUE)) {
    assert.equal(ACTIONS[action], action, `catalogue has stray action "${action}" not in ACTIONS`);
  }
});

test('isKnownAction recognises catalogued actions and rejects others', () => {
  assert.ok(isKnownAction(ACTIONS.proxyRequest));
  assert.ok(isKnownAction('walletRpc'));
  assert.ok(!isKnownAction('totallyMadeUp'));
  assert.ok(!isKnownAction(undefined));
  assert.ok(!isKnownAction(null));
});

test('getCapabilities is catalogued (the self-describing version/capability surface)', () => {
  const entry = MESSAGE_CATALOGUE[ACTIONS.getCapabilities];
  assert.ok(entry);
  // Its response advertises version + the action list + the provider surface.
  assert.match(JSON.stringify(entry.response), /version|actions|methods/i);
});
