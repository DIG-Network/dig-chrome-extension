/**
 * Tests for the base36 store-id codec + host/URL resolution in dig-urn.mjs.
 *
 * parse-urn.test.mjs already pins parseURN. This file covers the rest of the module —
 * the genuinely under-tested own-logic that drove dig-urn.mjs down to ~46% line coverage:
 *   - the base36 BigInt helpers (hexToInt / intToBase36 / base36ToInt / intToHex)
 *   - encodeStoreId / decodeStoreId (the subdomain codec) + their round-trip + error paths
 *   - resolveHostToURN (dig.local / localhost / 127.0.0.1 base domains, urn-path,
 *     path-based hex, 1-label "latest" subdomain, 2-label "specific version" subdomain,
 *     and the decode-failure branches)
 *   - urnToContentServerUrl (latest vs specific capsule, host/port options, invalid URN)
 *
 * These are pure functions (no DOM, no chrome.*), so they run under `node --test`.
 *
 * Run: node --test tests/
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  parseURN,
  resolveHostToURN,
  encodeStoreId,
  decodeStoreId,
  urnToContentServerUrl,
  hexToInt,
  intToBase36,
  base36ToInt,
  intToHex,
} from '@/lib/dig-urn';

const STORE = 'a'.repeat(64);
const ROOT = 'b'.repeat(64);

// ---------------------------------------------------------------------------
// base36 BigInt helpers
// ---------------------------------------------------------------------------

test('hexToInt parses a hex string to a BigInt', () => {
  assert.equal(hexToInt('ff'), 255n);
  assert.equal(hexToInt('00'), 0n);
  assert.equal(hexToInt('10'), 16n);
});

test('hexToInt throws a descriptive error on non-hex input', () => {
  assert.throws(() => hexToInt('zz'), /Invalid hex string: zz/);
});

test('intToBase36 maps 0n to "0"', () => {
  assert.equal(intToBase36(0n), '0');
});

test('intToBase36 uses digits 0-9 then a-z (base 36)', () => {
  assert.equal(intToBase36(9n), '9');
  assert.equal(intToBase36(10n), 'a'); // first letter
  assert.equal(intToBase36(35n), 'z'); // last digit in the alphabet
  assert.equal(intToBase36(36n), '10'); // carry into a second place
});

test('base36ToInt inverts intToBase36 and is case-insensitive', () => {
  assert.equal(base36ToInt('10'), 36n);
  assert.equal(base36ToInt('z'), 35n);
  assert.equal(base36ToInt('Z'), 35n, 'uppercase is accepted');
  assert.equal(base36ToInt('FF'), base36ToInt('ff'));
});

test('base36ToInt throws on an out-of-alphabet character', () => {
  assert.throws(() => base36ToInt('a-b'), /Invalid base36 character: -/);
});

test('intToHex pads to the requested length (default 64)', () => {
  assert.equal(intToHex(255n), 'ff'.padStart(64, '0'));
  assert.equal(intToHex(255n, 4), '00ff');
  assert.equal(intToHex(0n, 2), '00');
});

test('hex -> base36 -> hex round-trips for arbitrary 64-hex ids', () => {
  for (const id of [STORE, ROOT, 'deadbeef'.repeat(8), '0'.repeat(63) + '1', 'f'.repeat(64)]) {
    const enc = intToBase36(hexToInt(id));
    const back = intToHex(base36ToInt(enc), 64);
    assert.equal(back, id, `round-trip failed for ${id}`);
  }
});

// ---------------------------------------------------------------------------
// encodeStoreId / decodeStoreId
// ---------------------------------------------------------------------------

test('encodeStoreId rejects anything that is not 64 hex chars', () => {
  assert.throws(() => encodeStoreId('abc'), /Invalid store ID format/);
  assert.throws(() => encodeStoreId('g'.repeat(64)), /Invalid store ID format/);
  assert.throws(() => encodeStoreId(STORE + 'a'), /Invalid store ID format/);
});

test('encodeStoreId accepts upper- or lower-case 64-hex', () => {
  assert.equal(encodeStoreId(STORE), encodeStoreId(STORE.toUpperCase()));
});

test('encodeStoreId -> decodeStoreId round-trips back to the lowercase 64-hex id', () => {
  for (const id of [STORE, ROOT, 'deadbeef'.repeat(8), 'f'.repeat(64)]) {
    assert.equal(decodeStoreId(encodeStoreId(id)), id);
  }
});

test('decodeStoreId left-pads short ids to 64 hex chars', () => {
  // base36 "0" decodes to all-zero store id
  assert.equal(decodeStoreId('0'), '0'.repeat(64));
});

// ---------------------------------------------------------------------------
// resolveHostToURN
// ---------------------------------------------------------------------------

test('resolveHostToURN returns null for a host outside the supported base domains', () => {
  assert.equal(resolveHostToURN('example.com', '/'), null);
  assert.equal(resolveHostToURN('dig.local.evil.com', '/'), null);
});

test('resolveHostToURN: base domain + /urn:dig:... path passes the URN through (slash stripped)', () => {
  const urn = `urn:dig:chia:${STORE}/index.html`;
  assert.equal(resolveHostToURN('dig.local', '/' + urn), urn);
  assert.equal(resolveHostToURN('localhost', '/' + urn), urn);
  assert.equal(resolveHostToURN('127.0.0.1', '/' + urn), urn);
});

test('resolveHostToURN: base domain + path-based hex store id builds a urn (with + without resource)', () => {
  assert.equal(resolveHostToURN('dig.local', `/${STORE}`), `urn:dig:chia:${STORE}`);
  assert.equal(
    resolveHostToURN('dig.local', `/${STORE}/app.js`),
    `urn:dig:chia:${STORE}/app.js`
  );
});

test('resolveHostToURN: base domain with a non-matching path returns null', () => {
  assert.equal(resolveHostToURN('dig.local', '/favicon.ico'), null);
  assert.equal(resolveHostToURN('localhost', '/'), null);
});

test('resolveHostToURN: 1-label subdomain = latest capsule (encoded store id)', () => {
  const enc = encodeStoreId(STORE);
  assert.equal(resolveHostToURN(`${enc}.dig.local`, '/'), `urn:dig:chia:${STORE}`);
  assert.equal(
    resolveHostToURN(`${enc}.dig.local`, '/index.html'),
    `urn:dig:chia:${STORE}/index.html`
  );
});

test('resolveHostToURN: 1-label subdomain works for the localhost base domain too', () => {
  const enc = encodeStoreId(STORE);
  assert.equal(resolveHostToURN(`${enc}.localhost`, '/'), `urn:dig:chia:${STORE}`);
});

test('resolveHostToURN: 2-label subdomain = specific capsule (storeId:rootHash)', () => {
  const encStore = encodeStoreId(STORE);
  const encRoot = encodeStoreId(ROOT);
  assert.equal(
    resolveHostToURN(`${encStore}.${encRoot}.dig.local`, '/'),
    `urn:dig:chia:${STORE}:${ROOT}`
  );
  assert.equal(
    resolveHostToURN(`${encStore}.${encRoot}.dig.local`, '/css/site.css'),
    `urn:dig:chia:${STORE}:${ROOT}/css/site.css`
  );
});

test('resolveHostToURN: an undecodable 1-label subdomain returns null', () => {
  // "-" is not a valid base36 char -> decodeStoreId throws -> caught -> null
  assert.equal(resolveHostToURN('bad-label.dig.local', '/'), null);
});

test('resolveHostToURN: an undecodable 2-label subdomain returns null', () => {
  const encStore = encodeStoreId(STORE);
  assert.equal(resolveHostToURN(`${encStore}.bad-root.dig.local`, '/'), null);
});

test('resolveHostToURN: 3+ label subdomain is unsupported -> null', () => {
  const enc = encodeStoreId(STORE);
  assert.equal(resolveHostToURN(`${enc}.${enc}.${enc}.dig.local`, '/'), null);
});

// ---------------------------------------------------------------------------
// urnToContentServerUrl
// ---------------------------------------------------------------------------

test('urnToContentServerUrl returns null for an invalid URN', () => {
  assert.equal(urnToContentServerUrl('not-a-urn'), null);
});

test('urnToContentServerUrl: latest capsule -> single-label subdomain URL (default host/port)', () => {
  const url = urnToContentServerUrl(`urn:dig:chia:${STORE}/index.html`);
  const enc = encodeStoreId(STORE);
  assert.equal(url, `http://${enc}.dig.local/index.html`);
});

test('urnToContentServerUrl: specific capsule -> two-label subdomain URL', () => {
  const url = urnToContentServerUrl(`urn:dig:chia:${STORE}:${ROOT}/a.css`);
  const encStore = encodeStoreId(STORE);
  const encRoot = encodeStoreId(ROOT);
  assert.equal(url, `http://${encStore}.${encRoot}.dig.local/a.css`);
});

test('urnToContentServerUrl: a non-default port is appended (and 80 is omitted)', () => {
  const enc = encodeStoreId(STORE);
  assert.equal(
    urnToContentServerUrl(`urn:dig:chia:${STORE}`, { port: 8080 }),
    `http://${enc}.dig.local:8080/`
  );
  assert.equal(
    urnToContentServerUrl(`urn:dig:chia:${STORE}`, { port: 80 }),
    `http://${enc}.dig.local/`
  );
});

test('urnToContentServerUrl: a custom host is honoured', () => {
  const enc = encodeStoreId(STORE);
  assert.equal(
    urnToContentServerUrl(`urn:dig:chia:${STORE}`, { host: 'localhost' }),
    `http://${enc}.localhost/`
  );
});

test('urnToContentServerUrl: empty resourceKey yields a trailing slash', () => {
  const enc = encodeStoreId(STORE);
  assert.equal(urnToContentServerUrl(`urn:dig:chia:${STORE}`), `http://${enc}.dig.local/`);
});

// ---------------------------------------------------------------------------
// resolveHostToURN <-> urnToContentServerUrl are inverse for the subdomain forms
// ---------------------------------------------------------------------------

test('a content-server URL host resolves back to the same URN (latest)', () => {
  const enc = encodeStoreId(STORE);
  const urn = resolveHostToURN(`${enc}.dig.local`, '/index.html');
  assert.deepEqual(parseURN(urn!), {
    chain: 'chia', storeId: STORE, roothash: null, resourceKey: 'index.html', salt: null,
  });
});

test('a content-server URL host resolves back to the same URN (specific capsule)', () => {
  const encStore = encodeStoreId(STORE);
  const encRoot = encodeStoreId(ROOT);
  const urn = resolveHostToURN(`${encStore}.${encRoot}.dig.local`, '/x.js');
  assert.deepEqual(parseURN(urn!), {
    chain: 'chia', storeId: STORE, roothash: ROOT, resourceKey: 'x.js', salt: null,
  });
});
