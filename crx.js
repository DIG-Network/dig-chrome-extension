/**
 * CRX3 packaging + signing, the Chrome-valid version scheme, and the per-channel Omaha
 * `updates.xml` — the self-hosted auto-update contract for the DIG extension (#607, WU-1 of #602).
 *
 * WHY this exists: the extension is force-installed across Chromium browsers and auto-updates from
 * updates.dig.net (never the Chrome Web Store). A Chromium browser only accepts an update whose CRX
 * is signed by the SAME key as the installed copy — the extension id IS `SHA-256(public key)[:16]`
 * mapped into the a–p alphabet. So the id is PINNED, once and forever, by one keypair:
 *
 *   • the committed manifest `key` (public SPKI)         ─┐
 *   • the CRX3 signature's embedded public key            ├─ all derive  mlibddmbhlgogepnjdienclhnkfpkfah
 *   • the `appid` in every channel's updates.xml         ─┘
 *
 * Rotating the key changes the id and breaks every force-installed browser, so the public key lives
 * in gh variables + the manifest and the private key in the `EXT_NIGHTLY_CRX_KEY` secret (see the
 * canonical skill + SPEC §19). This module is pure/self-contained (Node stdlib only) so it is fully
 * unit-testable and carries no supply-chain surface.
 *
 * CommonJS on purpose: build.js (CJS) requires it directly, and the `node --test` suites import it
 * via createRequire.
 */

'use strict';

const crypto = require('crypto');

/**
 * The canonical, must-not-drift DIG extension id (canonical skill; gh var EXT_NIGHTLY_CRX_ID). The
 * force-install policy (#612) and every update_url pin this exact value.
 */
const CANONICAL_EXTENSION_ID = 'mlibddmbhlgogepnjdienclhnkfpkfah';

/**
 * The pinned public signing key as base64 SPKI (gh var EXT_NIGHTLY_CRX_PUBKEY). This is ALSO the
 * value committed as the manifest `key` field, so an unpacked/dev build derives the same id as a
 * signed CRX3. The matching private key is the `EXT_NIGHTLY_CRX_KEY` secret — never committed.
 */
const EXT_NIGHTLY_CRX_PUBKEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAmyEm/8/Hz2cTQqF9OaeoPrhU+XUEF3OxLAJ2KNIwUPVmqbnK6TU1svF4dAggwKNcpmDNEM1RHBxShWjJ+oyoOSg9eGSsBf5ewo4UEFNGoh12e1/XTN9Q6tvlLSMgyScZwFcJOONuPvl8XcAp06mlZArONQm2B6JFZjaxoDZTQcR0sttZ9hankgm2CwFp914Se64lq0NdeSFXjrlDKNHk62fbc52QUPMAoma571NAjMyIjzvbeEHpEvvJG59CNmvUK9HQZb+yyVwhY+fGl9UZ1g9Elajy7WZxbUy02/m4ymSfAArsibPLE2dsEoNgUXTet59C+6MMqJ+gbPBTWej+ZQIDAQAB';

/** UTC 2020-01-01 — the epoch for the nightly build-number (day counter). */
const EXT_EPOCH_UTC = Date.UTC(2020, 0, 1);

/** The self-hosted update origin (canonical skill: updates-dig-net bucket + CloudFront). */
const UPDATES_ORIGIN = 'https://updates.dig.net/ext';

// ───────────────────────────── extension id derivation ─────────────────────────────

/**
 * Derive a Chromium extension id from a DER-encoded SubjectPublicKeyInfo: the first 16 bytes of
 * SHA-256(spki), hex-encoded, then each hex nibble mapped 0–f → a–p (Chromium's "mpdecimal"
 * alphabet). Returns the 32-char id.
 */
function deriveExtensionId(publicKeyDer) {
  const digest = crypto.createHash('sha256').update(publicKeyDer).digest();
  let id = '';
  for (let i = 0; i < 16; i++) {
    const byte = digest[i];
    id += String.fromCharCode(97 + (byte >> 4));
    id += String.fromCharCode(97 + (byte & 0x0f));
  }
  return id;
}

/** The 16-byte crx_id (SHA-256(spki)[:16]) embedded in a CRX3 SignedData header. */
function crxIdBytes(publicKeyDer) {
  return crypto.createHash('sha256').update(publicKeyDer).digest().subarray(0, 16);
}

// ───────────────────────────── version scheme ─────────────────────────────

/**
 * The number of whole UTC days from 2020-01-01 to a `YYYYMMDD` string. This is the 4th manifest
 * version part for a nightly: strictly +1 per day and 16-bit-bounded until ~2199, so Chromium sees
 * each nightly as a strict version increase (the mechanism that makes self-update fire).
 */
function buildNumberFromYmd(ymd) {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(ymd));
  if (!m) throw new Error(`buildNumberFromYmd: expected YYYYMMDD, got ${JSON.stringify(ymd)}`);
  const [, y, mo, d] = m;
  const days = Math.floor((Date.UTC(Number(y), Number(mo) - 1, Number(d)) - EXT_EPOCH_UTC) / 86_400_000);
  if (days < 0 || days > 65_535) {
    throw new Error(`buildNumberFromYmd: day counter ${days} is outside Chrome's 0–65535 version-part bound`);
  }
  return days;
}

/**
 * Map a package.json version to a Chrome-valid `manifest.version` (1–4 dot-separated integers, each
 * 0–65535). A stable `X.Y.Z` passes through unchanged; a nightly `X.Y.Z-nightly.YYYYMMDD.<sha>`
 * becomes `X.Y.Z.<days-since-2020-01-01>` so it stays dotted-integer AND strictly increases each
 * night. The full pretty string is preserved separately in `version_name` by build.js.
 */
function chromeManifestVersion(fullVersion) {
  const s = String(fullVersion);
  const nightly = /^(\d+)\.(\d+)\.(\d+)-nightly\.(\d{8})(?:\.[0-9A-Za-z]+)?$/.exec(s);
  if (nightly) {
    const [, maj, min, pat, ymd] = nightly;
    return `${maj}.${min}.${pat}.${buildNumberFromYmd(ymd)}`;
  }
  // Any other suffix (or none) — take the leading dotted-integer base, matching Chrome's rule.
  return s.split(/[-+]/)[0];
}

// ───────────────────────────── updates.xml (Omaha gupdate protocol=2.0) ─────────────────────────────

/** Escape a string for use inside an XML double-quoted attribute value. */
function escapeXmlAttr(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** The per-channel update manifest URL a force-install policy points at. */
function updateXmlUrl(channel) {
  return `${UPDATES_ORIGIN}/${channel}/updates.xml`;
}

/** The per-channel download URL of a specific CRX version (the updates.xml `codebase`). */
function crxDownloadUrl(channel, version) {
  return `${UPDATES_ORIGIN}/${channel}/dig-network-extension-v${version}.crx`;
}

/**
 * Render an Omaha `gupdate` update manifest (protocol 2.0) advertising a single app version. A
 * Chromium browser polling the channel's update_url compares this `version` against the installed
 * one and pulls `codebase` when it is strictly higher.
 */
function generateUpdatesXml({ appid, codebase, version }) {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0">\n' +
    `  <app appid="${escapeXmlAttr(appid)}">\n` +
    `    <updatecheck codebase="${escapeXmlAttr(codebase)}" version="${escapeXmlAttr(version)}" />\n` +
    '  </app>\n' +
    '</gupdate>\n'
  );
}

// ───────────────────────────── CRX3 pack + sign ─────────────────────────────
//
// CRX3 layout (chromium components/crx_file/crx3.proto):
//   "Cr24" | uint32le version(=3) | uint32le headerLength | CrxFileHeader | zip
// CrxFileHeader { repeated AsymmetricKeyProof sha256_with_rsa = 2; bytes signed_header_data = 10000 }
// AsymmetricKeyProof { bytes public_key = 1; bytes signature = 2 }
// SignedData { bytes crx_id = 1 }  (crx_id = SHA-256(public_key)[:16])
// The signature is RSASSA-PKCS1-v1_5 / SHA-256 over:
//   "CRX3 SignedData\0" | uint32le(len(signed_header_data)) | signed_header_data | zip

const CRX3_SIGNED_DATA_MAGIC = Buffer.from('CRX3 SignedData\x00', 'latin1');

/** Encode an unsigned integer as a protobuf base-128 varint. */
function encodeVarint(n) {
  const out = [];
  let v = n;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v & 0x7f);
  return Buffer.from(out);
}

/** Encode one length-delimited (wire type 2) protobuf field: tag | length | bytes. */
function encodeLenField(fieldNumber, bytes) {
  const tag = encodeVarint(fieldNumber * 8 + 2);
  return Buffer.concat([tag, encodeVarint(bytes.length), bytes]);
}

/** The exact bytes the CRX3 signature is computed over (also used by tests to re-verify). */
function signedPayload(signedHeaderData, zip) {
  const len = Buffer.alloc(4);
  len.writeUInt32LE(signedHeaderData.length, 0);
  return Buffer.concat([CRX3_SIGNED_DATA_MAGIC, len, signedHeaderData, zip]);
}

/**
 * Pack + sign a built extension (its zip bytes) into a CRX3 archive with the given RSA private key
 * (PEM). Returns the CRX bytes, the derived extension id, and the DER public key. The signer refuses
 * an empty/invalid key rather than emitting an unsigned archive.
 */
function packCrx3({ zip, privateKeyPem }) {
  if (!privateKeyPem || !String(privateKeyPem).trim()) {
    throw new Error('packCrx3: a PEM RSA private key is required to sign the CRX');
  }
  const privateKey = crypto.createPrivateKey(privateKeyPem);
  const publicKeyDer = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });

  const signedHeaderData = encodeLenField(1, crxIdBytes(publicKeyDer)); // SignedData { crx_id }
  const signature = crypto.createSign('RSA-SHA256').update(signedPayload(signedHeaderData, zip)).sign(privateKey);

  const proof = Buffer.concat([encodeLenField(1, publicKeyDer), encodeLenField(2, signature)]); // AsymmetricKeyProof
  const header = Buffer.concat([
    encodeLenField(2, proof), // CrxFileHeader.sha256_with_rsa
    encodeLenField(10000, signedHeaderData), // CrxFileHeader.signed_header_data
  ]);

  const prefix = Buffer.alloc(12);
  prefix.write('Cr24', 0, 'latin1');
  prefix.writeUInt32LE(3, 4);
  prefix.writeUInt32LE(header.length, 8);

  const buf = Buffer.concat([prefix, header, zip]);
  return { crx: buf, id: deriveExtensionId(publicKeyDer), publicKeyDer };
}

/** Read a length-delimited protobuf field's payload from `buf` at `offset`; returns {fieldNumber, value, next}. */
function readLenField(buf, offset) {
  let tag = 0;
  let shift = 0;
  let pos = offset;
  for (;;) {
    const b = buf[pos++];
    tag += (b & 0x7f) * Math.pow(2, shift);
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  let len = 0;
  shift = 0;
  for (;;) {
    const b = buf[pos++];
    len += (b & 0x7f) * Math.pow(2, shift);
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  const value = buf.subarray(pos, pos + len);
  return { fieldNumber: Math.floor(tag / 8), value, next: pos + len };
}

/**
 * Parse a CRX3 archive back into its parts (public key, signature, signed header, id, zip). Used by
 * the test suite to assert the packer's framing + signature; not needed at build time.
 */
function parseCrx3(buf) {
  if (buf.subarray(0, 4).toString('latin1') !== 'Cr24') throw new Error('parseCrx3: not a Cr24 archive');
  const version = buf.readUInt32LE(4);
  const headerLength = buf.readUInt32LE(8);
  const header = buf.subarray(12, 12 + headerLength);
  const zip = buf.subarray(12 + headerLength);

  let signedHeaderData = null;
  let proof = null;
  for (let pos = 0; pos < header.length; ) {
    const field = readLenField(header, pos);
    if (field.fieldNumber === 2) proof = field.value;
    else if (field.fieldNumber === 10000) signedHeaderData = field.value;
    pos = field.next;
  }
  if (!proof) throw new Error('parseCrx3: missing sha256_with_rsa proof');

  let publicKeyDer = null;
  let signature = null;
  for (let pos = 0; pos < proof.length; ) {
    const field = readLenField(proof, pos);
    if (field.fieldNumber === 1) publicKeyDer = Buffer.from(field.value);
    else if (field.fieldNumber === 2) signature = Buffer.from(field.value);
    pos = field.next;
  }

  return {
    version,
    publicKeyDer,
    signature,
    signedHeaderData: signedHeaderData && Buffer.from(signedHeaderData),
    id: deriveExtensionId(publicKeyDer),
    zip: Buffer.from(zip),
  };
}

module.exports = {
  CANONICAL_EXTENSION_ID,
  EXT_NIGHTLY_CRX_PUBKEY,
  EXT_EPOCH_UTC,
  deriveExtensionId,
  crxIdBytes,
  buildNumberFromYmd,
  chromeManifestVersion,
  escapeXmlAttr,
  updateXmlUrl,
  crxDownloadUrl,
  generateUpdatesXml,
  signedPayload,
  packCrx3,
  parseCrx3,
};
