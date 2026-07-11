/**
 * Regression (#412): `chrome_settings_overrides.search_provider.favicon_url` MUST be an absolute
 * http(s) URL. Chrome rejects a bare extension-relative path (e.g. "src/icons/icon-32.png") at
 * manifest-parse time with "Invalid URL [...] for 'chrome_settings_overrides.search_provider'.
 * Could not load manifest." — which bricks the ENTIRE extension (it won't load at all). v1.86.0
 * shipped exactly this bug. favicon_url must also share the search_url host.
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));

test('search_provider.favicon_url is an absolute http(s) URL (never a relative extension path)', () => {
  const sp = manifest.chrome_settings_overrides?.search_provider;
  assert.ok(sp, 'chrome_settings_overrides.search_provider must exist');
  assert.equal(typeof sp.favicon_url, 'string');
  assert.match(
    sp.favicon_url,
    /^https:\/\//,
    'favicon_url must be an absolute https URL — Chrome rejects relative paths and bricks the whole manifest',
  );
});

test('search_provider.favicon_url shares the search_url host', () => {
  const sp = manifest.chrome_settings_overrides.search_provider;
  const favHost = new URL(sp.favicon_url).host;
  const searchHost = new URL(sp.search_url.replace('{searchTerms}', 'x')).host;
  assert.equal(favHost, searchHost, 'favicon_url host must match search_url host');
});
