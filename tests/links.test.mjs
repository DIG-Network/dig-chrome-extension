/**
 * Tests for the ecosystem funnel links (links.mjs).
 *
 * These pin the funnel destinations so a surface (popup button, Resources footer,
 * welcome page) can never silently drift to the wrong URL. The extension was a pure
 * RPC client with zero funneling; these links are the funnels added.
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HUB_URL,
  DIG_NETWORK_URL,
  DOCS_URL,
  TIBETSWAP_URL,
  DIG_BROWSER_URL,
  RESOURCE_LINKS,
} from '../links.mjs';

test('hub URL points at hub.dig.net', () => {
  assert.equal(HUB_URL, 'https://hub.dig.net');
});

test('DIG Network URL points at dig.net', () => {
  assert.equal(DIG_NETWORK_URL, 'https://dig.net');
});

test('docs URL points at docs.dig.net', () => {
  assert.equal(DOCS_URL, 'https://docs.dig.net');
});

test('Get-DIG URL points at TibetSwap', () => {
  assert.equal(TIBETSWAP_URL, 'https://v2.tibetswap.io/');
});

test('Full DIG Browser URL points at the releases page', () => {
  assert.equal(DIG_BROWSER_URL, 'https://github.com/DIG-Network/DIG_Browser/releases');
});

test('every funnel URL is an absolute https URL', () => {
  for (const url of [HUB_URL, DIG_NETWORK_URL, DOCS_URL, TIBETSWAP_URL, DIG_BROWSER_URL]) {
    const parsed = new URL(url); // throws if not absolute
    assert.equal(parsed.protocol, 'https:', `${url} must be https`);
  }
});

test('RESOURCE_LINKS contains Get DIG, Visit DIG Network, and Learn the protocol', () => {
  const byId = Object.fromEntries(RESOURCE_LINKS.map((l) => [l.id, l]));
  assert.equal(byId['get-dig'].url, TIBETSWAP_URL);
  assert.equal(byId['visit-dig-network'].url, DIG_NETWORK_URL);
  assert.equal(byId['learn-the-protocol'].url, DOCS_URL);
});

// Token symbol is plain "DIG" (no "$DIG") per ecosystem-wide consistency.
test('Get-DIG label uses the plain DIG token symbol (no $DIG)', () => {
  const getDig = RESOURCE_LINKS.find((l) => l.id === 'get-dig');
  assert.equal(getDig.label, 'Get DIG');
});

test('every RESOURCE_LINKS entry has a label, an https url, and is external', () => {
  for (const link of RESOURCE_LINKS) {
    assert.ok(link.label && link.label.length > 0, 'label present');
    assert.equal(new URL(link.url).protocol, 'https:', `${link.url} must be https`);
    assert.equal(link.external, true, `${link.id} should open a new tab`);
  }
});
