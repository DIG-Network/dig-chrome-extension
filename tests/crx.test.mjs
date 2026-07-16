/**
 * CRX3 self-update contract (#607, WU-1 of #602). The extension ships a self-hosted, signed CRX3
 * archive whose id is PINNED to the canonical id `mlibddmbhlgogepnjdienclhnkfpkfah` end-to-end:
 * the committed manifest `key` (public SPKI), the CRX3 signature's embedded public key, and the
 * `appid` in the per-channel Omaha `updates.xml` all derive the SAME id. If any of these drifts,
 * every force-installed browser stops receiving updates — so this suite locks the id-pin, the
 * Chrome-valid monotonic version scheme, the updates.xml shape, and the CRX3 pack/sign format.
 *
 * The signing tests use an EPHEMERAL RSA-2048 keypair (never the real EXT_NIGHTLY_CRX_KEY) — they
 * prove the packer produces a well-formed, signature-valid CRX3 whose derived id matches the packed
 * public key. A separate test proves the REAL committed public key derives the canonical id.
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const crx = require('../crx.js');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The canonical, must-not-drift DIG extension id (canonical skill; EXT_NIGHTLY_CRX_ID). */
const CANONICAL_ID = 'mlibddmbhlgogepnjdienclhnkfpkfah';

test('the canonical id is exported as a frozen constant', () => {
  assert.equal(crx.CANONICAL_EXTENSION_ID, CANONICAL_ID);
});

test('the committed manifest `key` derives the canonical extension id', () => {
  // The whole self-update trust chain rests on this: SHA-256(public SPKI)[:16] mapped a–p == the id
  // the force-install policy pins. The manifest `key` field carries the SAME public key the CRX3 is
  // signed under, so an unpacked/dev build and the signed build share one id.
  const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
  assert.equal(typeof manifest.key, 'string', 'manifest.json must carry a committed public-key `key`');
  const der = Buffer.from(manifest.key, 'base64');
  assert.equal(crx.deriveExtensionId(der), CANONICAL_ID);
});

test('the manifest `key` equals the pinned public SPKI (EXT_NIGHTLY_CRX_PUBKEY)', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
  assert.equal(manifest.key, crx.EXT_NIGHTLY_CRX_PUBKEY);
});

test('deriveExtensionId maps SHA-256(SPKI)[:16] into the a–p mpdecimal alphabet', () => {
  const der = Buffer.from(crx.EXT_NIGHTLY_CRX_PUBKEY, 'base64');
  const id = crx.deriveExtensionId(der);
  assert.match(id, /^[a-p]{32}$/, 'a Chrome id is 32 chars over the a–p alphabet');
});

// ───────────────────────────── version scheme ─────────────────────────────

test('a stable version stays the plain dotted X.Y.Z', () => {
  assert.equal(crx.chromeManifestVersion('1.101.0'), '1.101.0');
  assert.equal(crx.chromeManifestVersion('2.0.5'), '2.0.5');
});

test('a nightly version becomes X.Y.Z.<days-since-2020-01-01> (Chrome-valid, monotone)', () => {
  // A nightly package version is `X.Y.Z-nightly.YYYYMMDD.<sha>`. Chrome forbids the semver suffix in
  // manifest.version, and raw YYYYMMDD (20260716) overflows the 65535-per-part limit. The 4th part
  // is instead the day count since 2020-01-01 UTC — a strictly day-over-day increasing integer that
  // fits 16 bits until ~2199, so the browser detects each new nightly as a strict upgrade.
  const days = crx.buildNumberFromYmd('20260716');
  assert.equal(crx.chromeManifestVersion('1.101.0-nightly.20260716.abc1234'), `1.101.0.${days}`);
});

test('every version part stays within Chrome\'s 0–65535 bound', () => {
  const v = crx.chromeManifestVersion('1.101.0-nightly.20260716.abc1234');
  for (const part of v.split('.')) {
    assert.ok(Number(part) >= 0 && Number(part) <= 65535, `part ${part} must be a 16-bit integer`);
  }
});

test('the nightly build number strictly increases day-over-day', () => {
  const d1 = crx.buildNumberFromYmd('20260716');
  const d2 = crx.buildNumberFromYmd('20260717');
  const d3 = crx.buildNumberFromYmd('20270101');
  assert.ok(d2 === d1 + 1, 'consecutive days differ by exactly 1');
  assert.ok(d3 > d2, 'a later date yields a strictly larger build number');
  assert.ok(d1 > 0);
});

test('buildNumberFromYmd fits the 16-bit part bound for the foreseeable future', () => {
  assert.ok(crx.buildNumberFromYmd('21001231') <= 65535, 'the day counter must stay 16-bit until well past 2100');
});

// ───────────────────────────── updates.xml (Omaha gupdate) ─────────────────────────────

test('generateUpdatesXml emits a protocol-2.0 gupdate manifest with the pinned appid', () => {
  const xml = crx.generateUpdatesXml({
    appid: CANONICAL_ID,
    codebase: 'https://updates.dig.net/ext/nightly/dig-network-extension-v1.101.0.2388.crx',
    version: '1.101.0.2388',
  });
  assert.match(xml, /<gupdate xmlns="http:\/\/www\.google\.com\/update2\/response" protocol="2\.0">/);
  assert.match(xml, new RegExp(`<app appid="${CANONICAL_ID}">`));
  assert.match(xml, /codebase="https:\/\/updates\.dig\.net\/ext\/nightly\/dig-network-extension-v1\.101\.0\.2388\.crx"/);
  assert.match(xml, /version="1\.101\.0\.2388"/);
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
});

test('generateUpdatesXml XML-escapes attribute values (a & in a URL cannot break the manifest)', () => {
  const xml = crx.generateUpdatesXml({
    appid: CANONICAL_ID,
    codebase: 'https://updates.dig.net/ext/nightly/x.crx?a=1&b=2',
    version: '1.0.0',
  });
  assert.ok(xml.includes('&amp;'), 'an & in the codebase URL must be escaped to &amp;');
  assert.ok(!/&(?!amp;|lt;|gt;|quot;)/.test(xml), 'no unescaped bare & may survive');
});

test('the per-channel update_url + crx download url follow the canonical updates.dig.net layout', () => {
  assert.equal(crx.updateXmlUrl('nightly'), 'https://updates.dig.net/ext/nightly/updates.xml');
  assert.equal(crx.updateXmlUrl('stable'), 'https://updates.dig.net/ext/stable/updates.xml');
  assert.equal(
    crx.crxDownloadUrl('stable', '1.101.0'),
    'https://updates.dig.net/ext/stable/dig-network-extension-v1.101.0.crx',
  );
});

// ───────────────────────────── CRX3 pack + sign ─────────────────────────────

/** A tiny fake "zip" payload — the packer treats it as opaque bytes; only the framing/signing matter here. */
const FAKE_ZIP = Buffer.from('PK\x03\x04 fake zip content for CRX framing tests');

test('packCrx3 produces a Cr24/version-3 archive whose embedded key derives the packed id', () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });

  const { crx: packed, id, publicKeyDer } = crx.packCrx3({ zip: FAKE_ZIP, privateKeyPem });

  assert.equal(packed.subarray(0, 4).toString('latin1'), 'Cr24', 'CRX3 magic');
  assert.equal(packed.readUInt32LE(4), 3, 'CRX format version 3');

  const parsed = crx.parseCrx3(packed);
  assert.ok(parsed.publicKeyDer.equals(publicKeyDer), 'the parsed public key equals the packing key');
  assert.ok(parsed.zip.equals(FAKE_ZIP), 'the zip payload round-trips byte-identically');
  assert.equal(parsed.id, id, 'the parsed id matches the returned id');
  assert.equal(crx.deriveExtensionId(publicKeyDer), id, 'the returned id is derived from the public key');
});

test('the CRX3 signature verifies (RSASSA-PKCS1-v1_5 / SHA-256 over the CRX3 SignedData payload)', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });

  const { crx: packed } = crx.packCrx3({ zip: FAKE_ZIP, privateKeyPem });
  const parsed = crx.parseCrx3(packed);

  const payload = crx.signedPayload(parsed.signedHeaderData, parsed.zip);
  const ok = crypto.createVerify('RSA-SHA256').update(payload).verify(publicKey, parsed.signature);
  assert.ok(ok, 'the CRX3 signature must verify against the embedded public key');
});

test('packCrx3 rejects a non-RSA / missing key rather than emitting an unsigned archive', () => {
  assert.throws(() => crx.packCrx3({ zip: FAKE_ZIP, privateKeyPem: '' }), /private key/i);
});
