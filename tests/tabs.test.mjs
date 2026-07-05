/**
 * Pure tab-model tests for the 4-tab popup (Resolver · Wallet · Shield · Control Panel).
 *
 * tabs.mjs is the single source of truth for the popup's tab set, order, default, and the
 * hash→tab deep-link resolution. Keeping it a pure module (no DOM/chrome.*) means the routing
 * is unit-testable and the popup renderer is thin glue over it.
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { TABS, DEFAULT_TAB, isTab, resolveInitialTab, tabPanelId, tabTestId } from '../tabs.mjs';

test('TABS is the ordered 4-tab set: resolver, wallet, shield, control', () => {
  assert.deepEqual([...TABS], ['resolver', 'wallet', 'shield', 'control']);
});

test('DEFAULT_TAB is the resolver (the extension\'s core surface, tab 1)', () => {
  assert.equal(DEFAULT_TAB, 'resolver');
  assert.ok(TABS.includes(DEFAULT_TAB));
});

test('isTab recognises only the known tabs', () => {
  for (const t of TABS) assert.equal(isTab(t), true);
  for (const bad of ['', 'nope', 'Wallet', null, undefined, 42]) assert.equal(isTab(bad), false);
});

test('resolveInitialTab honours a valid #hash deep-link', () => {
  assert.equal(resolveInitialTab('#wallet'), 'wallet');
  assert.equal(resolveInitialTab('#shield'), 'shield');
  assert.equal(resolveInitialTab('#control'), 'control');
  assert.equal(resolveInitialTab('#resolver'), 'resolver');
  // bare (no '#') form tolerated too
  assert.equal(resolveInitialTab('wallet'), 'wallet');
});

test('resolveInitialTab falls back to DEFAULT_TAB for missing/unknown hashes', () => {
  assert.equal(resolveInitialTab(''), DEFAULT_TAB);
  assert.equal(resolveInitialTab('#'), DEFAULT_TAB);
  assert.equal(resolveInitialTab('#garbage'), DEFAULT_TAB);
  assert.equal(resolveInitialTab(null), DEFAULT_TAB);
  assert.equal(resolveInitialTab(undefined), DEFAULT_TAB);
});

test('tabPanelId maps each tab to its panel element id', () => {
  assert.equal(tabPanelId('resolver'), 'resolverPanel');
  assert.equal(tabPanelId('wallet'), 'walletPanel');
  assert.equal(tabPanelId('shield'), 'shieldPanel');
  assert.equal(tabPanelId('control'), 'controlPanel');
});

test('tabTestId is a stable, agent-driveable data-testid per tab', () => {
  assert.equal(tabTestId('resolver'), 'tab-resolver');
  assert.equal(tabTestId('wallet'), 'tab-wallet');
  assert.equal(tabTestId('shield'), 'tab-shield');
  assert.equal(tabTestId('control'), 'tab-control');
});
