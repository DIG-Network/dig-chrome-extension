import { describe, it, expect } from 'vitest';
import { matchesAssetQuery, filterAssetsByQuery, assetAutocompleteSuggestions } from '@/features/wallet/custody/assetFilter';
import type { AssetBalance } from '@/features/wallet/assetTypes';
import type { AssetDescriptor } from '@/lib/wallet-assets';
import type { CatMetaMap } from '@/features/wallet/catMetadata';

function descriptor(over: Partial<AssetDescriptor>): AssetDescriptor {
  return { key: 'cat', ticker: 'CAT', name: 'Token', decimals: 3, assetId: null, type: 'cat', ...over };
}
function row(over: Partial<AssetDescriptor>): AssetBalance {
  const d = descriptor(over);
  return { descriptor: d, balance: 1, label: '1' };
}

const digRow = row({ key: 'dig', ticker: '$DIG', name: 'DIG' });
const sbxRow = row({ ticker: 'SBX', name: 'Spacebucks', assetId: 'a'.repeat(64) });
const unknownRow = row({ ticker: 'CAT', name: 'a1b2…c3d4', assetId: 'b'.repeat(64) });

describe('matchesAssetQuery', () => {
  it('matches case-insensitively against the ticker', () => {
    expect(matchesAssetQuery(sbxRow, 'sbx')).toBe(true);
    expect(matchesAssetQuery(sbxRow, 'SBX')).toBe(true);
  });

  it('matches case-insensitively against the name', () => {
    expect(matchesAssetQuery(sbxRow, 'space')).toBe(true);
    expect(matchesAssetQuery(sbxRow, 'SPACEBUCKS')).toBe(true);
  });

  it('does not match an unrelated query', () => {
    expect(matchesAssetQuery(sbxRow, 'zzz')).toBe(false);
  });

  it('treats a blank/whitespace query as matching everything', () => {
    expect(matchesAssetQuery(sbxRow, '')).toBe(true);
    expect(matchesAssetQuery(sbxRow, '   ')).toBe(true);
  });
});

describe('filterAssetsByQuery', () => {
  const rows = [digRow, sbxRow, unknownRow];

  it('returns every row unchanged when the query is blank', () => {
    expect(filterAssetsByQuery(rows, '')).toBe(rows); // same reference — no needless re-render
    expect(filterAssetsByQuery(rows, '  ')).toEqual(rows);
  });

  it('narrows to rows matching the ticker or name', () => {
    expect(filterAssetsByQuery(rows, 'dig')).toEqual([digRow]);
    expect(filterAssetsByQuery(rows, 'space')).toEqual([sbxRow]);
  });

  it('returns an empty array when nothing matches', () => {
    expect(filterAssetsByQuery(rows, 'nonexistent-token-xyz')).toEqual([]);
  });
});

describe('assetAutocompleteSuggestions', () => {
  const rows = [digRow, sbxRow];
  const registry: CatMetaMap = {
    ['c'.repeat(64)]: { name: 'Stably USD', ticker: 'USDS', iconUrl: null, decimals: 3 },
    ['d'.repeat(64)]: { name: 'Spacebucks', ticker: 'SBX', iconUrl: null, decimals: 3 }, // dupes a held ticker
  };

  it('suggests held assets even with no query', () => {
    const s = assetAutocompleteSuggestions(rows, null, '');
    expect(s.map((x) => x.ticker)).toEqual(expect.arrayContaining(['$DIG', 'SBX']));
  });

  it('includes registry-only tokens (not currently held) as candidates', () => {
    const s = assetAutocompleteSuggestions(rows, registry, 'usd');
    expect(s.map((x) => x.ticker)).toContain('USDS');
  });

  it('matches by name too, case-insensitively', () => {
    const s = assetAutocompleteSuggestions(rows, registry, 'space');
    expect(s.map((x) => x.ticker)).toContain('SBX');
  });

  it('dedupes a ticker held AND in the registry (held wins, no duplicate entry)', () => {
    const s = assetAutocompleteSuggestions(rows, registry, 'sbx');
    expect(s.filter((x) => x.ticker === 'SBX')).toHaveLength(1);
  });

  it('ranks a prefix match before a mere substring match', () => {
    const withMid: CatMetaMap = { ...registry, ['e'.repeat(64)]: { name: 'Not-Usd-Prefixed', ticker: 'NUP', iconUrl: null, decimals: 3 } };
    const s = assetAutocompleteSuggestions([], withMid, 'usd');
    // "USDS" starts with "usd"; "NUP" (name "Not-Usd-Prefixed") only contains it — prefix ranks first.
    expect(s[0].ticker).toBe('USDS');
  });

  it('returns nothing for a query that matches no known ticker or name', () => {
    expect(assetAutocompleteSuggestions(rows, registry, 'zzz-nope')).toEqual([]);
  });

  it('caps the suggestion count to keep the list short', () => {
    const big: CatMetaMap = {};
    for (let i = 0; i < 30; i++) {
      big[String(i).padStart(64, '0')] = { name: `Token ${i}`, ticker: `TK${i}`, iconUrl: null, decimals: 3 };
    }
    const s = assetAutocompleteSuggestions([], big, 'tk');
    expect(s.length).toBeLessThanOrEqual(8);
  });
});
