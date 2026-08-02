/**
 * Deterministic ZIP writer (#710). Proves the pure-Node zipper that replaced the shell
 * `zip`/`Compress-Archive` calls: it round-trips content faithfully, sorts + fixes timestamps so the
 * SAME input packs to BYTE-IDENTICAL bytes (the reproducible-build property), recurses nested
 * directories (the win32 `Compress-Archive -Path 'dist/*'` bug this fixes DROPPED nested subtrees),
 * and honours the sourcemap exclusion.
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';

const require = createRequire(import.meta.url);
const zip = require('../zip.js');

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;

/**
 * Minimal ZIP reader for the tests: walk the central directory and return `{ name → Buffer }`,
 * inflating deflated entries. Independent of the writer, so it genuinely re-derives the content
 * rather than trusting the producer.
 */
function readZip(buf) {
  // Locate the end-of-central-directory record (no trailing comment, so it's the last 22 bytes).
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== EOCD_SIG) eocd--;
  assert.ok(eocd >= 0, 'EOCD signature not found');
  const total = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  const out = {};
  for (let i = 0; i < total; i++) {
    assert.equal(buf.readUInt32LE(ptr), CENTRAL_SIG, 'central-directory signature');
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOff = buf.readUInt32LE(ptr + 42);
    const name = buf.toString('utf8', ptr + 46, ptr + 46 + nameLen);
    // Jump to the local header to read the payload (local name/extra lengths are authoritative there).
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    out[name] = method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

test('makeZip round-trips entry content (store + deflate paths)', () => {
  const entries = [
    { name: 'manifest.json', data: Buffer.from('{"a":1}') },
    { name: 'assets/big.txt', data: Buffer.from('x'.repeat(5000)) }, // compressible → deflate path
    { name: 'tiny', data: Buffer.from('no') }, // too small to shrink → stored
  ];
  const back = readZip(zip.makeZip(entries));
  assert.deepEqual(Object.keys(back).sort(), ['assets/big.txt', 'manifest.json', 'tiny']);
  for (const e of entries) assert.deepEqual(back[e.name], e.data, `${e.name} bytes`);
});

test('makeZip is deterministic: input order does not change the bytes', () => {
  const a = [
    { name: 'b.txt', data: Buffer.from('bee') },
    { name: 'a.txt', data: Buffer.from('ay') },
    { name: 'nested/c.txt', data: Buffer.from('see') },
  ];
  const reversed = [...a].reverse();
  assert.deepEqual(zip.makeZip(a), zip.makeZip(reversed), 'entry order must not affect output');
  // And re-running on the identical input yields identical bytes (no wall-clock timestamp leak).
  assert.deepEqual(zip.makeZip(a), zip.makeZip(a));
});

test('makeZip stamps a fixed 1980-01-01 DOS timestamp (no wall-clock drift)', () => {
  const buf = zip.makeZip([{ name: 'f', data: Buffer.from('z') }]);
  // Local header: modtime@10 = 0x0000, moddate@12 = 0x0021 (1980-01-01).
  assert.equal(buf.readUInt16LE(10), 0x0000, 'DOS time must be fixed midnight');
  assert.equal(buf.readUInt16LE(12), 0x0021, 'DOS date must be fixed 1980-01-01');
});

test('zipDir recurses nested directories and applies the exclude filter', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zip710-'));
  try {
    mkdirSync(join(dir, 'assets'), { recursive: true });
    mkdirSync(join(dir, 'src', 'icons'), { recursive: true });
    writeFileSync(join(dir, 'manifest.json'), '{"manifest_version":3}');
    writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)');
    writeFileSync(join(dir, 'assets', 'app.js.map'), '{"version":3}'); // must be excluded
    writeFileSync(join(dir, 'src', 'icons', 'icon-16.png'), 'PNGDATA');
    const back = readZip(zip.zipDir(dir, { exclude: [/\.map$/] }));
    const names = Object.keys(back).sort();
    // Nested subtrees present (the win32 fallback bug this fixes lost these) …
    assert.deepEqual(names, ['assets/app.js', 'manifest.json', 'src/icons/icon-16.png']);
    // … the sourcemap excluded, and names use forward slashes on every platform.
    assert.ok(!names.includes('assets/app.js.map'), 'sourcemap must be excluded');
    assert.deepEqual(back['src/icons/icon-16.png'], Buffer.from('PNGDATA'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('crc32 matches zlib.crc32 for a known input', () => {
  const data = Buffer.from('The DIG Network');
  assert.equal(zip.crc32(data) >>> 0, zlib.crc32(data) >>> 0);
});
