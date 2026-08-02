/**
 * Deterministic, cross-platform ZIP writer (#710).
 *
 * WHY this exists: the extension's release artifacts (the Chrome-Web-Store zip, the sideload zip,
 * and the CRX3 payload) were produced by shelling out to `zip` on Unix and PowerShell
 * `Compress-Archive` on Windows. Two problems fell out of that:
 *   1. `Compress-Archive -Path 'dist/*'` is unreliable for NESTED directories (dist/assets, dist/src)
 *      across PowerShell versions — the wildcard form has repeatedly shipped archives missing whole
 *      subtrees, so the Windows build could emit a broken/incomplete extension.
 *   2. Both `zip` and `Compress-Archive` stamp each entry with the file's wall-clock mtime and iterate
 *      the directory in filesystem order, so the SAME source produced BYTE-DIFFERENT zips run to run —
 *      no reproducible build, and no way to prove two zips carry identical content.
 *
 * This module builds the zip in pure Node (zlib only), so it behaves identically on every platform and
 * is fully unit-testable, and it is DETERMINISTIC: entries are sorted by name, every entry is stamped
 * with a fixed DOS timestamp, and no OS/extra metadata is written. The same input bytes therefore
 * produce a byte-identical archive (for a given Node/zlib toolchain — the deflate stream is a function
 * of the fixed level + the platform zlib).
 *
 * CommonJS on purpose: build.js (CJS) requires it directly, and the `node --test` suites import it via
 * createRequire. Pure Node stdlib — no supply-chain surface (mirrors crx.js).
 */

'use strict';

const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

// The MS-DOS date/time every entry is stamped with: 1980-01-01 00:00:00, the earliest a ZIP DOS
// timestamp can encode. Fixing it is what removes wall-clock drift from the output.
const DOS_DATE_1980_01_01 = 0x0021; // (year-1980)<<9 | month<<5 | day  =  0<<9 | 1<<5 | 1
const DOS_TIME_MIDNIGHT = 0x0000;

// ZIP local-file / central-directory / end-of-central-directory signatures.
const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

// ───────────────────────────── CRC-32 (IEEE 802.3) ─────────────────────────────

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 of a Buffer, the checksum every ZIP entry header carries. */
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC32_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ───────────────────────────── archive assembly ─────────────────────────────

/**
 * Build a ZIP archive Buffer from `entries` (`[{ name, data: Buffer }]`). Entries are sorted by name
 * (so input order never changes the output), each is stamped with the fixed 1980-01-01 timestamp, and
 * a file is deflate-compressed only when that actually shrinks it (otherwise stored). No data
 * descriptors, no extra fields, no zip64 — the archive is a flat, reproducible byte stream.
 *
 * `name` MUST use forward slashes for any nested path (the ZIP path separator on every platform).
 */
function makeZip(entries) {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const localChunks = [];
  const centralChunks = [];
  let localOffset = 0;

  for (const entry of sorted) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const uncompressedSize = entry.data.length;
    const crc = crc32(entry.data);

    // Store (method 0) unless deflate genuinely shrinks the file — keeps tiny files from growing.
    let method = 0;
    let payload = entry.data;
    if (uncompressedSize > 0) {
      const deflated = zlib.deflateRawSync(entry.data, { level: 9 });
      if (deflated.length < uncompressedSize) {
        method = 8;
        payload = deflated;
      }
    }
    const compressedSize = payload.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // general-purpose flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME_MIDNIGHT, 10);
    local.writeUInt16LE(DOS_DATE_1980_01_01, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressedSize, 18);
    local.writeUInt32LE(uncompressedSize, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra-field length
    localChunks.push(local, nameBuf, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME_MIDNIGHT, 12);
    central.writeUInt16LE(DOS_DATE_1980_01_01, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressedSize, 20);
    central.writeUInt32LE(uncompressedSize, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra-field length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number start
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(0, 38); // external attributes
    central.writeUInt32LE(localOffset, 42);
    centralChunks.push(central, nameBuf);

    localOffset += local.length + nameBuf.length + payload.length;
  }

  const localPart = Buffer.concat(localChunks);
  const centralPart = Buffer.concat(centralChunks);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4); // this disk number
  eocd.writeUInt16LE(0, 6); // disk with central directory
  eocd.writeUInt16LE(sorted.length, 8); // entries on this disk
  eocd.writeUInt16LE(sorted.length, 10); // total entries
  eocd.writeUInt32LE(centralPart.length, 12);
  eocd.writeUInt32LE(localPart.length, 16); // central-directory offset
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([localPart, centralPart, eocd]);
}

/**
 * Collect every file under `dir` as `{ name, data }` entries with archive-root-relative, forward-slash
 * names — the shape `makeZip` consumes. Directories are recursed in sorted order; any file whose
 * relative name matches an `exclude` RegExp is skipped (e.g. `/\.map$/` to drop sourcemaps).
 */
function collectDirEntries(dir, { exclude = [] } = {}) {
  const entries = [];
  const walk = (absDir, relDir) => {
    const dirents = fs
      .readdirSync(absDir, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const dirent of dirents) {
      const childAbs = path.join(absDir, dirent.name);
      const childRel = relDir ? `${relDir}/${dirent.name}` : dirent.name;
      if (dirent.isDirectory()) {
        walk(childAbs, childRel);
      } else if (dirent.isFile() && !exclude.some((re) => re.test(childRel))) {
        entries.push({ name: childRel, data: fs.readFileSync(childAbs) });
      }
    }
  };
  walk(dir, '');
  return entries;
}

/** Deterministically zip the CONTENTS of `dir` (root-relative entries) into a Buffer. */
function zipDir(dir, options = {}) {
  return makeZip(collectDirEntries(dir, options));
}

module.exports = { crc32, makeZip, collectDirEntries, zipDir };
