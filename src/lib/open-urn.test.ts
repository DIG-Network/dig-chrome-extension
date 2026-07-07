/**
 * Tests for #172's open-by-URN decision core (src/lib/open-urn.ts) — validation/normalization
 * against the shared §4 URN grammar (dig-urn.ts `parseURN`), and the dig-dns-detect branch (#172
 * comments 2/3): `.dig`-scheme navigation when the shared availability signal reports dig-dns
 * reachable, else the extension's own chrome-extension:// content view (dig-viewer.html).
 */
import { describe, it, expect } from 'vitest';
import {
  parseOpenUrnInput,
  buildDigSchemeUrl,
  buildContentViewUrl,
  resolveOpenTarget,
} from '@/lib/open-urn';

const STORE_ID = 'a'.repeat(64);
const ROOT_HASH = 'b'.repeat(64);
// base32 labels for the 32-byte ids 0xAA...AA (hex "a".repeat(64)) and 0xBB...BB (hex
// "b".repeat(64)) — computed independently and pinned here; dig-dns-host.test.ts separately proves
// the codec against the dig-dns Rust fixtures, so this file only needs internally-consistent values.
const STORE_LABEL = 'vkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkva';
const ROOT_LABEL = 'xo53xo53xo53xo53xo53xo53xo53xo53xo53xo53xo53xo53xo5q';

describe('parseOpenUrnInput', () => {
  it('accepts a bare chia:// address', () => {
    const parsed = parseOpenUrnInput(`chia://${STORE_ID}/index.html`);
    expect(parsed).toEqual({ chain: 'chia', storeId: STORE_ID, roothash: null, resourceKey: 'index.html', salt: null });
  });

  it('accepts a rooted urn:dig: form', () => {
    const parsed = parseOpenUrnInput(`urn:dig:chia:${STORE_ID}:${ROOT_HASH}/a.png`);
    expect(parsed).toEqual({ chain: 'chia', storeId: STORE_ID, roothash: ROOT_HASH, resourceKey: 'a.png', salt: null });
  });

  it('accepts a bare (chainless) store id', () => {
    const parsed = parseOpenUrnInput(STORE_ID);
    expect(parsed?.storeId).toBe(STORE_ID);
    expect(parsed?.chain).toBe('chia');
  });

  it('trims surrounding whitespace', () => {
    expect(parseOpenUrnInput(`  chia://${STORE_ID}  `)).not.toBeNull();
  });

  it('rejects empty / whitespace-only input', () => {
    expect(parseOpenUrnInput('')).toBeNull();
    expect(parseOpenUrnInput('   ')).toBeNull();
  });

  it('rejects garbage that is not a URN or chia:// address', () => {
    expect(parseOpenUrnInput('not a urn')).toBeNull();
    expect(parseOpenUrnInput('https://example.com')).toBeNull();
    expect(parseOpenUrnInput('chia://short-id')).toBeNull();
  });
});

describe('buildDigSchemeUrl', () => {
  it('builds the latest-capsule form for a rootless URN', () => {
    const parsed = parseOpenUrnInput(`chia://${STORE_ID}`);
    expect(buildDigSchemeUrl(parsed!)).toBe(`http://${STORE_LABEL}.dig/`);
  });

  it('builds the pinned root.store form for a rooted URN', () => {
    // A bare `chia://<storeId>:<root>` (no chain) is ambiguous to parseURN (the first `:`-token is
    // read as the chain) — use the unambiguous `urn:dig:chia:` form, matching store-refs.ts's
    // documented gotcha and SPEC.md §4.1's canonical shape.
    const parsed = parseOpenUrnInput(`urn:dig:chia:${STORE_ID}:${ROOT_HASH}`);
    expect(buildDigSchemeUrl(parsed!)).toBe(`http://${ROOT_LABEL}.${STORE_LABEL}.dig/`);
  });

  it('appends the resource path when present', () => {
    const parsed = parseOpenUrnInput(`chia://${STORE_ID}/assets/app.js`);
    expect(buildDigSchemeUrl(parsed!)).toBe(`http://${STORE_LABEL}.dig/assets/app.js`);
  });
});

describe('buildContentViewUrl', () => {
  it('canonicalizes to the chain-prefixed chia:// form the background proxyRequest/navigateToDigUrl expects', () => {
    const parsed = parseOpenUrnInput(STORE_ID);
    expect(buildContentViewUrl(parsed!)).toBe(`chia://chia:${STORE_ID}/index.html`);
  });

  it('preserves a pinned root and a resource key', () => {
    const parsed = parseOpenUrnInput(`urn:dig:chia:${STORE_ID}:${ROOT_HASH}/a.png`);
    expect(buildContentViewUrl(parsed!)).toBe(`chia://chia:${STORE_ID}:${ROOT_HASH}/a.png`);
  });

  it('carries a private-store salt', () => {
    const parsed = parseOpenUrnInput(`chia://${STORE_ID}/index.html?salt=deadbeef`);
    expect(buildContentViewUrl(parsed!)).toBe(`chia://chia:${STORE_ID}/index.html?salt=deadbeef`);
  });
});

describe('resolveOpenTarget (#172 dig-dns-detect branch)', () => {
  const parsed = parseOpenUrnInput(`chia://${STORE_ID}`)!;

  it('phase "direct" (dig-dns reachable) -> the native .dig scheme', () => {
    expect(resolveOpenTarget(parsed, 'direct')).toEqual({ kind: 'dig-scheme', url: `http://${STORE_LABEL}.dig/` });
  });

  it('phase "proxy" (dig-dns reachable via the PAC self-heal fallback) -> the native .dig scheme too', () => {
    expect(resolveOpenTarget(parsed, 'proxy')).toEqual({ kind: 'dig-scheme', url: `http://${STORE_LABEL}.dig/` });
  });

  it('phase "unavailable" -> the chrome-extension:// content view', () => {
    expect(resolveOpenTarget(parsed, 'unavailable')).toEqual({ kind: 'content-view', url: `chia://chia:${STORE_ID}/index.html` });
  });

  it('no signal yet (undefined/null) -> conservatively falls back to the content view', () => {
    expect(resolveOpenTarget(parsed, undefined).kind).toBe('content-view');
    expect(resolveOpenTarget(parsed, null).kind).toBe('content-view');
  });
});
