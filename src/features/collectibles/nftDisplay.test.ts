import { describe, it, expect } from 'vitest';
import type { WalletNft } from '@/offscreen/nfts';
import {
  shortHex,
  nftDisplayName,
  editionLabel,
  royaltyPercentLabel,
  nftImageSrc,
  nftExternalImageUrl,
  nftMonogram,
  groupByCollection,
} from './nftDisplay';

function nft(over: Partial<WalletNft> = {}): WalletNft {
  return {
    launcherId: 'ab'.repeat(32),
    coinId: 'cd'.repeat(32),
    p2PuzzleHash: 'ef'.repeat(32),
    collectionId: null,
    editionNumber: '1',
    editionTotal: '1',
    royaltyBasisPoints: 0,
    royaltyPuzzleHash: '00'.repeat(32),
    dataUris: [],
    dataHash: null,
    metadataUris: [],
    metadataHash: null,
    licenseUris: [],
    ...over,
  };
}

describe('shortHex', () => {
  it('shortens a long hex and strips 0x', () => {
    expect(shortHex('0x' + 'a'.repeat(64))).toBe('aaaaaa…aaaa');
  });
  it('leaves short values intact', () => {
    expect(shortHex('abcd')).toBe('abcd');
  });
});

describe('nftDisplayName', () => {
  it('is a shortened launcher id', () => {
    expect(nftDisplayName(nft({ launcherId: '112233445566778899aabbccddeeff01'.repeat(2) }))).toBe('112233…ff01');
  });
});

describe('editionLabel', () => {
  it('is null for a plain 1/1', () => {
    expect(editionLabel(nft({ editionNumber: '1', editionTotal: '1' }))).toBeNull();
  });
  it('shows #n of total for a real edition', () => {
    expect(editionLabel(nft({ editionNumber: '3', editionTotal: '10' }))).toBe('#3 of 10');
  });
  it('shows #n when total is 1 but number is not', () => {
    expect(editionLabel(nft({ editionNumber: '5', editionTotal: '1' }))).toBe('#5');
  });
});

describe('royaltyPercentLabel', () => {
  it('renders integer percents', () => {
    expect(royaltyPercentLabel(300)).toBe('3%');
    expect(royaltyPercentLabel(0)).toBe('0%');
  });
  it('renders and trims fractional percents', () => {
    expect(royaltyPercentLabel(250)).toBe('2.5%');
    expect(royaltyPercentLabel(125)).toBe('1.25%');
  });
});

describe('nftImageSrc / nftExternalImageUrl', () => {
  it('embeds a data: URI', () => {
    const n = nft({ dataUris: ['data:image/png;base64,AAAA'] });
    expect(nftImageSrc(n)).toBe('data:image/png;base64,AAAA');
    expect(nftExternalImageUrl(n)).toBeNull();
  });
  it('never embeds a remote URL, offers it as an external link', () => {
    const n = nft({ dataUris: ['https://ipfs.example/img.png'] });
    expect(nftImageSrc(n)).toBeNull();
    expect(nftExternalImageUrl(n)).toBe('https://ipfs.example/img.png');
  });
  it('returns null for no URIs', () => {
    expect(nftImageSrc(nft())).toBeNull();
    expect(nftExternalImageUrl(nft())).toBeNull();
  });
});

describe('nftMonogram', () => {
  it('is the first two hex chars uppercased', () => {
    expect(nftMonogram(nft({ launcherId: 'de'.repeat(32) }))).toBe('DE');
  });
});

describe('groupByCollection', () => {
  it('groups by collectionId with the ungrouped bucket last', () => {
    const a = nft({ launcherId: 'a1'.repeat(32), collectionId: 'did1' });
    const b = nft({ launcherId: 'b2'.repeat(32), collectionId: null });
    const c = nft({ launcherId: 'c3'.repeat(32), collectionId: 'did1' });
    const groups = groupByCollection([b, a, c]);
    // 'did1' leads (named), null bucket last.
    expect(groups.map((g) => g.collectionId)).toEqual(['did1', null]);
    expect(groups[0].nfts.map((n) => n.launcherId)).toEqual([a.launcherId, c.launcherId]);
    expect(groups[1].nfts).toEqual([b]);
  });
  it('handles an all-ungrouped list', () => {
    expect(groupByCollection([nft(), nft({ launcherId: '99'.repeat(32) })])).toHaveLength(1);
  });
  it('is empty for no NFTs', () => {
    expect(groupByCollection([])).toEqual([]);
  });
});
