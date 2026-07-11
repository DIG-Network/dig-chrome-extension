import { describe, it, expect } from 'vitest';
import { parseLoaderInput, loaderDisplayAddress, buildLoaderPageUrl } from '@/lib/dig-loader';

describe('parseLoaderInput (#311 — the ?input= the loader page reads)', () => {
  it('decodes a URL-encoded chia:// value', () => {
    expect(parseLoaderInput('?input=chia%3A%2F%2Fchia%3A' + 'a'.repeat(64))).toBe(`chia://chia:${'a'.repeat(64)}`);
  });

  it('returns null for a missing/empty param (a directly-opened loader with no context)', () => {
    expect(parseLoaderInput('')).toBeNull();
    expect(parseLoaderInput('?other=1')).toBeNull();
    expect(parseLoaderInput('?input=')).toBeNull();
  });

  it('fully decodes a double-encoded value (some nav paths encode twice)', () => {
    const raw = `chia://${'b'.repeat(64)}/index.html`;
    const doubleEncoded = encodeURIComponent(encodeURIComponent(raw));
    expect(parseLoaderInput(`?input=${doubleEncoded}`)).toBe(raw);
  });
});

describe('loaderDisplayAddress (#311 — the friendly, truncated subtitle text)', () => {
  it('returns a generic placeholder for null/empty input', () => {
    expect(loaderDisplayAddress(null)).toBe('your DIG address');
    expect(loaderDisplayAddress('')).toBe('your DIG address');
  });

  it('shows the address as-is when short', () => {
    expect(loaderDisplayAddress('chia://abc')).toBe('chia://abc');
  });

  it('truncates a long address with an ellipsis, never overflowing the card', () => {
    const long = `chia://${'c'.repeat(64)}/some/very/long/nested/resource/path.html`;
    const shown = loaderDisplayAddress(long, 40);
    expect(shown.length).toBeLessThanOrEqual(41); // 40 chars + ellipsis
    expect(shown.endsWith('…')).toBe(true);
    expect(long.startsWith(shown.slice(0, -1))).toBe(true);
  });
});

describe('buildLoaderPageUrl (#311 — the extension URL the SW flashes the tab to first)', () => {
  it('embeds the raw digUrl as a single-encoded ?input= query param', () => {
    const digUrl = `chia://${'d'.repeat(64)}/index.html`;
    const url = buildLoaderPageUrl((path: string) => `chrome-extension://abc/${path}`, digUrl);
    expect(url).toBe(`chrome-extension://abc/dig-loader.html?input=${encodeURIComponent(digUrl)}`);
    // Round-trips through parseLoaderInput.
    const search = url.slice(url.indexOf('?'));
    expect(parseLoaderInput(search)).toBe(digUrl);
  });
});
