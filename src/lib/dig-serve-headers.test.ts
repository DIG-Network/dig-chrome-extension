import { describe, it, expect } from 'vitest';
import { readServeHeaders } from '@/lib/dig-serve-headers';

const ROOT = 'c'.repeat(64);

describe('readServeHeaders', () => {
  it('parses a verified, chain-rooted, local-served response (Headers instance)', () => {
    const h = new Headers({ 'X-Dig-Verified': 'true', 'X-Dig-Root': ROOT, 'X-Dig-Source': 'local' });
    expect(readServeHeaders(h)).toEqual({ verified: true, root: ROOT, source: 'local' });
  });

  it('parses a failed verdict', () => {
    const h = new Headers({ 'X-Dig-Verified': 'false', 'X-Dig-Source': 'peer' });
    expect(readServeHeaders(h)).toEqual({ verified: false, root: null, source: 'peer' });
  });

  it('accepts a plain object with case-insensitive header names', () => {
    expect(readServeHeaders({ 'x-dig-verified': 'TRUE', 'x-dig-source': 'RPC' })).toEqual({
      verified: true,
      root: null,
      source: 'rpc',
    });
  });

  it('absent verification header → verified null (not a node-served DIG response)', () => {
    expect(readServeHeaders({})).toEqual({ verified: null, root: null, source: null });
    expect(readServeHeaders(null)).toEqual({ verified: null, root: null, source: null });
  });

  it('rejects a malformed root (not 64-hex) and an unknown source', () => {
    const v = readServeHeaders({ 'X-Dig-Verified': 'true', 'X-Dig-Root': 'nope', 'X-Dig-Source': 'moon' });
    expect(v).toEqual({ verified: true, root: null, source: null });
  });
});
