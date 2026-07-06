import { describe, it, expect } from 'vitest';
import {
  validateMintForm,
  royaltyPercentToBasisPoints,
  feeToMojos,
  looksLikeUri,
  basisPointsToPercentLabel,
  EMPTY_MINT_FORM,
  type MintForm,
} from './nftMint';

/** A valid bech32m XCH address (32 zero bytes) for royalty-address tests. */
const XCH_ADDR = 'xch1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqluuwcx';
const HASH = 'ab'.repeat(32);

function form(over: Partial<MintForm> = {}): MintForm {
  return { ...EMPTY_MINT_FORM, mediaUri: 'https://example.test/img.png', ...over };
}

describe('nftMint — royalty + fee parsing', () => {
  it('converts a royalty percent to basis points', () => {
    expect(royaltyPercentToBasisPoints('2.5')).toBe(250);
    expect(royaltyPercentToBasisPoints('0')).toBe(0);
    expect(royaltyPercentToBasisPoints('')).toBe(0);
    expect(royaltyPercentToBasisPoints('100')).toBe(10000);
  });
  it('rejects an out-of-range or non-numeric royalty', () => {
    expect(royaltyPercentToBasisPoints('-1')).toBeNull();
    expect(royaltyPercentToBasisPoints('101')).toBeNull();
    expect(royaltyPercentToBasisPoints('abc')).toBeNull();
  });
  it('parses a fee in XCH to mojos', () => {
    expect(feeToMojos('')).toBe(0);
    expect(feeToMojos('0')).toBe(0);
    expect(feeToMojos('0.000001')).toBe(1_000_000);
  });
  it('rejects a negative or garbage fee', () => {
    expect(feeToMojos('-1')).toBeNull();
    expect(feeToMojos('nope')).toBeNull();
  });
  it('recognises plausible URIs', () => {
    expect(looksLikeUri('https://x.test/a.png')).toBe(true);
    expect(looksLikeUri('ipfs://cid')).toBe(true);
    expect(looksLikeUri('not a url')).toBe(false);
    expect(looksLikeUri('')).toBe(false);
  });
  it('formats basis points as a percent label', () => {
    expect(basisPointsToPercentLabel(250)).toBe('2.5%');
    expect(basisPointsToPercentLabel(0)).toBe('0%');
  });
});

describe('nftMint — validateMintForm', () => {
  it('builds wire params from a minimal valid form (media only)', () => {
    const r = validateMintForm(form());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.params.dataUris).toEqual(['https://example.test/img.png']);
    expect(r.params.royaltyBasisPoints).toBe(0);
    expect(r.params.fee).toBe('0');
    expect(r.params.metadataUris).toBeUndefined();
    expect(r.params.royaltyAddress).toBeUndefined();
  });

  it('maps every optional field through when supplied', () => {
    const r = validateMintForm(
      form({
        mediaHash: HASH,
        metadataUri: 'https://example.test/meta.json',
        metadataHash: HASH,
        licenseUri: 'https://example.test/license.txt',
        licenseHash: HASH,
        royaltyPercent: '5',
        royaltyAddress: XCH_ADDR,
        fee: '0.000001',
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.params.dataHash).toBe(HASH);
    expect(r.params.metadataUris).toEqual(['https://example.test/meta.json']);
    expect(r.params.metadataHash).toBe(HASH);
    expect(r.params.licenseUris).toEqual(['https://example.test/license.txt']);
    expect(r.params.licenseHash).toBe(HASH);
    expect(r.params.royaltyBasisPoints).toBe(500);
    expect(r.params.royaltyAddress).toBe(XCH_ADDR);
    expect(r.params.fee).toBe('1000000');
  });

  it('requires a media URI', () => {
    const r = validateMintForm(form({ mediaUri: '' }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.mediaUri).toBe('mint.error.mediaRequired');
  });

  it('rejects a malformed media URI', () => {
    const r = validateMintForm(form({ mediaUri: 'not a url' }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.mediaUri).toBe('mint.error.mediaUri');
  });

  it('rejects a non-64-hex hash', () => {
    const r = validateMintForm(form({ mediaHash: 'xyz' }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.mediaHash).toBe('mint.error.hash');
  });

  it('rejects an out-of-range royalty', () => {
    const r = validateMintForm(form({ royaltyPercent: '200' }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.royaltyPercent).toBe('mint.error.royalty');
  });

  it('rejects an invalid royalty address', () => {
    const r = validateMintForm(form({ royaltyAddress: 'nope' }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.royaltyAddress).toBe('mint.error.address');
  });
});
