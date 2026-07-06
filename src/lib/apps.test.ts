/**
 * Tests for the DIG Home app directory + omnibox classifier (apps.mjs).
 *
 * The new-tab override (DIG Home) is ported from the native DIG Browser's NTP. These
 * tests pin (a) the app directory targets so the extension surfaces the same ecosystem
 * apps as the browser, and (b) the omnibox classifier so "store id / chia:// → DIG
 * Network, URL → navigate, else → DuckDuckGo" behaves identically to the browser NTP.
 *
 * Run: node --test tests/
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  DIG_APPS,
  DIG_HOME_FOOTER_LINKS,
  WEB_SEARCH_URL,
  classifyOmnibox,
  omniboxTarget,
} from '@/lib/apps';

const STORE = 'a'.repeat(64);

test('app directory lists the four ecosystem apps with correct hosts', () => {
  const byHost = Object.fromEntries(DIG_APPS.map((a) => [a.host, a]));
  assert.equal(byHost['hub.dig.net'].url, 'https://hub.dig.net');
  assert.equal(byHost['xchannuity.app'].url, 'https://xchannuity.app');
  assert.equal(byHost['v2.tibetswap.io'].url, 'https://v2.tibetswap.io');
  assert.equal(byHost['docs.dig.net'].url, 'https://docs.dig.net');
});

test('TibetSwap is marked as a $DIG (token) destination', () => {
  const tibet = DIG_APPS.find((a) => a.host === 'v2.tibetswap.io')!;
  assert.equal(tibet.dig, true);
  // $DIG sigil on first reference (SYSTEM.md "Token: $DIG").
  assert.equal(tibet.chip, 'Buy $DIG');
  assert.match(tibet.blurb, /\$DIG/, 'TibetSwap blurb should carry the $DIG sigil');
});

test('DIG Home footer offers all three Get-$DIG venues in order', () => {
  // The footer must surface the canonical three venues (mirrors hub GET_DIG_SOURCES),
  // not TibetSwap alone.
  const getDig = DIG_HOME_FOOTER_LINKS.filter((l) => /\$DIG/.test(l.label));
  assert.deepEqual(
    getDig.map((l) => l.url),
    [
      'https://v2.tibetswap.io/',
      'https://dexie.space/offers/a406d3a9de984d03c9591c10d917593b434d5263cabe2b42f6b367df16832f81/XCH',
      'https://xch.9mm.pro/token/a406d3a9de984d03c9591c10d917593b434d5263cabe2b42f6b367df16832f81',
    ],
  );
});

test('every app entry has a name, host, https url, glyph and blurb', () => {
  for (const a of DIG_APPS) {
    assert.ok(a.name, 'name');
    assert.ok(a.host, 'host');
    assert.equal(new URL(a.url).protocol, 'https:', `${a.url} https`);
    assert.ok(a.glyph, 'glyph');
    assert.ok(a.blurb && a.blurb.length > 0, 'blurb');
  }
});

test('footer links are absolute https', () => {
  for (const l of DIG_HOME_FOOTER_LINKS) {
    assert.equal(new URL(l.url).protocol, 'https:');
    assert.ok(l.label);
  }
});

test('web search fallback is DuckDuckGo', () => {
  assert.ok(WEB_SEARCH_URL.startsWith('https://duckduckgo.com/'));
});

test('classifyOmnibox: chia:// and urn:dig: are DIG', () => {
  assert.equal(classifyOmnibox('chia://urn:dig:chia:' + STORE), 'dig');
  assert.equal(classifyOmnibox('urn:dig:chia:' + STORE), 'dig');
});

test('classifyOmnibox: bare 64-hex store id is DIG', () => {
  assert.equal(classifyOmnibox(STORE), 'dig');
  assert.equal(classifyOmnibox(STORE + '/index.html'), 'dig');
});

test('classifyOmnibox: http(s) URL and bare domain are URL', () => {
  assert.equal(classifyOmnibox('https://example.com'), 'url');
  assert.equal(classifyOmnibox('example.com/path'), 'url');
});

test('classifyOmnibox: plain words are search', () => {
  assert.equal(classifyOmnibox('what is dig'), 'search');
  assert.equal(classifyOmnibox(''), 'search');
});

test('omniboxTarget: DIG values resolve to a chia:// URL (strips scheme + urn:dig:, like the browser NTP)', () => {
  // Mirrors dig_newtab.html: v.replace(/^chia:\/\//).replace(/^urn:dig:/) then prefix chia://
  assert.equal(omniboxTarget('chia://urn:dig:chia:' + STORE), 'chia://chia:' + STORE);
  assert.equal(omniboxTarget('urn:dig:chia:' + STORE), 'chia://chia:' + STORE);
  assert.equal(omniboxTarget(STORE), 'chia://' + STORE);
});

test('omniboxTarget: bare domain gets https://', () => {
  assert.equal(omniboxTarget('example.com'), 'https://example.com');
  assert.equal(omniboxTarget('https://example.com'), 'https://example.com');
});

test('omniboxTarget: words go to DuckDuckGo search', () => {
  assert.equal(omniboxTarget('hello world'), WEB_SEARCH_URL + encodeURIComponent('hello world'));
});
