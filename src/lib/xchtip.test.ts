import { describe, it, expect } from 'vitest';
import {
  XCHTIP_ORIGIN,
  isXchAddress,
  xchtipJarUrl,
  xchtipBuilderUrl,
  xchtipEmbedSnippet,
} from '@/lib/xchtip';

const REAL = 'xch1z8dvd7jg0dl9wgy9lr5j0d0k5j3l4m6n7p8q9r0s1t2u3v4w5xq6y7z8a';

describe('xchtip — address guard', () => {
  it('accepts a plausible lowercase xch1 bech32m address', () => {
    expect(isXchAddress(REAL)).toBe(true);
  });
  it('rejects empty / wrong-prefix / uppercase / too-short', () => {
    expect(isXchAddress('')).toBe(false);
    expect(isXchAddress('txch1abcdef...')).toBe(false);
    expect(isXchAddress('XCH1ABC')).toBe(false);
    expect(isXchAddress('xch1')).toBe(false); // no data part
    expect(isXchAddress(undefined as unknown as string)).toBe(false);
  });
});

describe('xchtip — URL + snippet builders', () => {
  it('origin is the production domain', () => {
    expect(XCHTIP_ORIGIN).toBe('https://xchtip.app');
  });

  it('xchtipJarUrl builds the ready-to-share tip page (recipient in the path, lowercased)', () => {
    expect(xchtipJarUrl(REAL)).toBe(`https://xchtip.app/jar/${REAL}`);
    // XCH is the default asset → no ?asset query; unknown/empty address → null.
    expect(xchtipJarUrl('')).toBeNull();
  });

  it('xchtipJarUrl appends a display name when given', () => {
    const url = xchtipJarUrl(REAL, { name: 'Alice B' });
    expect(url).toBe(`https://xchtip.app/jar/${REAL}?name=Alice+B`);
  });

  it('xchtipBuilderUrl pre-fills the builder form for the address (asset=xch)', () => {
    expect(xchtipBuilderUrl(REAL)).toBe(`https://xchtip.app/?recipient=${REAL}&asset=xch`);
    expect(xchtipBuilderUrl('nope')).toBeNull();
  });

  it('xchtipEmbedSnippet builds a copyable one-line <script> with the required data-attrs', () => {
    const snip = xchtipEmbedSnippet(REAL);
    expect(snip).not.toBeNull();
    const s = snip as string;
    expect(s).toContain('src="https://xchtip.app/embed/xch-tip.js"');
    expect(s).toContain(`data-recipient="${REAL}"`);
    expect(s).toContain('data-asset="xch"');
    expect(s).toContain('async');
    expect(s.startsWith('<script')).toBe(true);
    expect(s.trim().endsWith('</script>')).toBe(true);
    expect(xchtipEmbedSnippet('bad')).toBeNull();
  });

  it('xchtipEmbedSnippet is HTML-safe (address is guarded, so no injection surface)', () => {
    // A rejected address never reaches the snippet.
    expect(xchtipEmbedSnippet('<script>evil')).toBeNull();
  });
});
