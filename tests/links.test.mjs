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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  HUB_URL,
  DIG_NETWORK_URL,
  DOCS_URL,
  TIBETSWAP_URL,
  DEXIE_DIG_URL,
  NINEMM_DIG_URL,
  DIG_ASSET_ID,
  GET_DIG_SOURCES,
  DISCORD_URL,
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

test('Get-$DIG URL points at TibetSwap', () => {
  assert.equal(TIBETSWAP_URL, 'https://v2.tibetswap.io/');
});

// The canonical DIG CAT asset id (tail hash). Mirrors hub apps/web/lib/links.js DIG_ASSET_ID.
test('DIG CAT asset id is the canonical tail hash', () => {
  assert.equal(
    DIG_ASSET_ID,
    'a406d3a9de984d03c9591c10d917593b434d5263cabe2b42f6b367df16832f81',
  );
});

test('dexie + 9mm.pro Get-$DIG URLs are built from the DIG CAT asset id', () => {
  assert.equal(DEXIE_DIG_URL, `https://dexie.space/offers/${DIG_ASSET_ID}/XCH`);
  assert.equal(NINEMM_DIG_URL, `https://xch.9mm.pro/token/${DIG_ASSET_ID}`);
});

// GET_DIG_SOURCES mirrors hub apps/web/lib/links.js: three venues, TibetSwap → dexie → 9mm.pro.
test('GET_DIG_SOURCES lists the three canonical venues in order (mirrors hub)', () => {
  assert.equal(GET_DIG_SOURCES.length, 3);
  assert.deepEqual(
    GET_DIG_SOURCES.map((s) => s.name),
    ['TibetSwap', 'dexie', '9mm.pro'],
  );
  assert.deepEqual(
    GET_DIG_SOURCES.map((s) => s.url),
    [TIBETSWAP_URL, DEXIE_DIG_URL, NINEMM_DIG_URL],
  );
  for (const s of GET_DIG_SOURCES) {
    assert.equal(new URL(s.url).protocol, 'https:', `${s.url} must be https`);
    assert.ok(s.hint && s.hint.length > 0, `${s.name} should have a hint`);
  }
});

// Canonical org Discord (matches SYSTEM.md + dig.net + docs.dig.net + hub).
test('Discord URL is the canonical org invite', () => {
  assert.equal(DISCORD_URL, 'https://discord.gg/dignetwork');
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

test('RESOURCE_LINKS contains Get $DIG, Visit DIG Network, and Learn the protocol', () => {
  const byId = Object.fromEntries(RESOURCE_LINKS.map((l) => [l.id, l]));
  assert.equal(byId['get-dig'].url, TIBETSWAP_URL);
  assert.equal(byId['visit-dig-network'].url, DIG_NETWORK_URL);
  assert.equal(byId['learn-the-protocol'].url, DOCS_URL);
});

// The token carries the $DIG sigil on first reference (SYSTEM.md "Token: $DIG").
test('Get-$DIG label uses the $DIG sigil', () => {
  const getDig = RESOURCE_LINKS.find((l) => l.id === 'get-dig');
  assert.equal(getDig.label, 'Get $DIG');
});

test('every RESOURCE_LINKS entry has a label, an https url, and is external', () => {
  for (const link of RESOURCE_LINKS) {
    assert.ok(link.label && link.label.length > 0, 'label present');
    assert.equal(new URL(link.url).protocol, 'https:', `${link.url} must be https`);
    assert.equal(link.external, true, `${link.id} should open a new tab`);
  }
});

// popup.js is a classic script (can't `import`) so it mirrors RESOURCE_LINKS inline. This
// guards the two from drifting: the popup's labels MUST match links.mjs verbatim (so e.g. the
// $DIG sigil can never be present in one surface and missing in the other).
test('popup.js RESOURCE_LINKS labels mirror links.mjs verbatim', () => {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const popup = readFileSync(join(root, 'popup.js'), 'utf8');
  for (const link of RESOURCE_LINKS) {
    assert.match(
      popup,
      new RegExp(`id:\\s*'${link.id}',\\s*label:\\s*'${link.label.replace(/\$/g, '\\$')}'`),
      `popup.js must mirror RESOURCE_LINKS "${link.id}" label "${link.label}"`,
    );
  }
});
