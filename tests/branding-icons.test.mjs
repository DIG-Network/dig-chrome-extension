/**
 * Regression (#153): the manifest used to point EVERY icon size at the same single
 * `src/favicon.png` (a blurry 32x32 raster), and no shipped extension page carried a
 * `<link rel="icon">` at all (Chrome fell back to a generic document icon in the tab).
 *
 * This pins:
 *   - manifest.json's `action.default_icon` and `icons` blocks each reference FOUR DISTINCT
 *     crisp per-size files (16/32/48/128), not one file reused everywhere;
 *   - every referenced manifest icon file actually exists on disk;
 *   - every shipped extension HTML page (popup, fullscreen wallet, approval, offscreen vault,
 *     options, welcome, DIG Home new-tab, DIG Viewer) links the DIG Mark as its tab favicon;
 *   - build.js actually copies the DIG Mark icon set into dist/ (the old `ICON_SIZES`/`ICONS_DIR`
 *     constants existed but were never wired to a real copy step).
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(ROOT, f), 'utf8');

const ICON_SIZES = [16, 32, 48, 128];

// Every extension page actually shipped (built by Vite into dist/ — see build.js buildWebApp()).
const SHIPPED_PAGES = [
  'popup.html',
  'app.html',
  'approval.html',
  'offscreen.html',
  'options.html',
  'welcome.html',
  'newtab.html',
  'dig-viewer.html',
];

test('manifest.json action.default_icon references four distinct per-size DIG Mark files', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const iconMap = manifest.action.default_icon;
  const paths = ICON_SIZES.map((size) => iconMap[String(size)]);
  assert.ok(
    paths.every(Boolean),
    `action.default_icon must define all of ${ICON_SIZES.join('/')}`,
  );
  assert.equal(
    new Set(paths).size,
    paths.length,
    'action.default_icon must NOT reuse the same file for every size (found duplicates)',
  );
  for (const p of paths) {
    assert.match(p, /^src\/icons\/icon-\d+\.png$/, `unexpected icon path shape: ${p}`);
  }
});

test('manifest.json icons (extension-management / store listing) references the same four-size set', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const iconMap = manifest.icons;
  const paths = ICON_SIZES.map((size) => iconMap[String(size)]);
  assert.ok(paths.every(Boolean), `icons must define all of ${ICON_SIZES.join('/')}`);
  assert.equal(new Set(paths).size, paths.length, 'icons must NOT reuse the same file for every size');
});

test('every manifest-referenced DIG Mark icon file exists on disk', () => {
  const manifest = JSON.parse(read('manifest.json'));
  for (const size of ICON_SIZES) {
    const relPath = manifest.action.default_icon[String(size)];
    assert.ok(existsSync(join(ROOT, relPath)), `missing icon file: ${relPath}`);
  }
});

for (const page of SHIPPED_PAGES) {
  test(`${page} links the DIG Mark as its tab favicon`, () => {
    const html = read(page);
    const match = html.match(/<link\s+rel="icon"[^>]*href="([^"]+)"/);
    assert.ok(match, `${page} is missing a <link rel="icon"> tag`);
    const href = match[1];
    assert.match(href, /^src\/icons\/icon-\d+\.png$/, `${page} favicon href looks generic: ${href}`);
    assert.ok(existsSync(join(ROOT, href)), `${page} favicon references a missing file: ${href}`);
  });
}

test('build.js copies the DIG Mark icon set (src/icons/) into dist/, not just the dead ICON_SIZES constant', () => {
  const buildJs = read('build.js');
  assert.match(buildJs, /ICON_SIZES\s*=\s*\[16,\s*32,\s*48,\s*128\]/, 'ICON_SIZES must list all four sizes');
  assert.match(
    buildJs,
    /for \(const size of ICON_SIZES\)/,
    'build.js must actually iterate ICON_SIZES to copy each icon (not leave it unused)',
  );
});
