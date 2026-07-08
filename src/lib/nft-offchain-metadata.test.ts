import { describe, it, expect } from 'vitest';
import { parseNftOffchainMetadata, decodeDataUriJson } from '@/lib/nft-offchain-metadata';

describe('parseNftOffchainMetadata (#98 CHIP-0007 off-chain document)', () => {
  it('parses a full, well-formed CHIP-0007 document', () => {
    const doc = {
      format: 'CHIP-0007',
      name: 'Cool Cat #42',
      description: 'A very cool cat.',
      minting_tool: 'DIG',
      sensitive_content: false,
      series_number: 42,
      series_total: 1000,
      attributes: [
        { trait_type: 'Background', value: 'Blue' },
        { trait_type: 'Eyes', value: 'Green' },
      ],
      collection: {
        id: 'col-123',
        name: 'Cool Cats',
        attributes: [{ type: 'banner', value: 'https://example.test/banner.png' }],
      },
    };
    expect(parseNftOffchainMetadata(doc)).toEqual({
      format: 'CHIP-0007',
      name: 'Cool Cat #42',
      description: 'A very cool cat.',
      sensitiveContent: false,
      attributes: [
        { traitType: 'Background', value: 'Blue' },
        { traitType: 'Eyes', value: 'Green' },
      ],
      collection: {
        id: 'col-123',
        name: 'Cool Cats',
        attributes: [{ type: 'banner', value: 'https://example.test/banner.png' }],
      },
      seriesNumber: 42,
      seriesTotal: 1000,
      mintingTool: 'DIG',
    });
  });

  it('accepts the legacy `trait_type` key for a collection attribute (chip35_dl_coin #189 fix parity)', () => {
    const doc = { collection: { id: 'c1', name: 'Legacy Set', attributes: [{ trait_type: 'banner', value: 'x' }] } };
    expect(parseNftOffchainMetadata(doc)?.collection?.attributes).toEqual([{ type: 'banner', value: 'x' }]);
  });

  it('prefers the current `type` key over a legacy `trait_type` when both are present', () => {
    const doc = { collection: { id: 'c1', name: 'X', attributes: [{ type: 'current', trait_type: 'legacy', value: 'x' }] } };
    expect(parseNftOffchainMetadata(doc)?.collection?.attributes).toEqual([{ type: 'current', value: 'x' }]);
  });

  it('accepts a numeric attribute value (CHIP-0007 allows string or number)', () => {
    const doc = { name: 'N', attributes: [{ trait_type: 'Level', value: 7 }] };
    expect(parseNftOffchainMetadata(doc)?.attributes).toEqual([{ traitType: 'Level', value: '7' }]);
  });

  it('returns a name-only document with defaults for every other field', () => {
    expect(parseNftOffchainMetadata({ name: 'Just A Name' })).toEqual({
      format: null,
      name: 'Just A Name',
      description: null,
      sensitiveContent: false,
      attributes: [],
      collection: null,
      seriesNumber: null,
      seriesTotal: null,
      mintingTool: null,
    });
  });

  it.each([null, undefined, 'a string', 42, [], true])('returns null for a non-object document: %j', (bad) => {
    expect(parseNftOffchainMetadata(bad)).toBeNull();
  });

  it('returns null for an object with none of the recognized fields (nothing usable)', () => {
    expect(parseNftOffchainMetadata({ unrelated: 'field', another: 123 })).toBeNull();
  });

  it('drops a malformed attribute entry (missing trait_type or value) but keeps the valid ones', () => {
    const doc = {
      name: 'N',
      attributes: [{ trait_type: 'Good', value: 'ok' }, { value: 'no trait type' }, { trait_type: 'no value' }, 'not an object', null],
    };
    expect(parseNftOffchainMetadata(doc)?.attributes).toEqual([{ traitType: 'Good', value: 'ok' }]);
  });

  it('caps the attributes array at 100 entries (hostile/oversized document)', () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ trait_type: `t${i}`, value: `v${i}` }));
    expect(parseNftOffchainMetadata({ name: 'N', attributes: many })?.attributes).toHaveLength(100);
  });

  it('caps an overlong name/description string rather than rejecting the whole document', () => {
    const longName = 'x'.repeat(5000);
    const parsed = parseNftOffchainMetadata({ name: longName, description: longName });
    expect(parsed?.name).toHaveLength(200);
    expect(parsed?.description).toHaveLength(4000);
  });

  it('treats an empty/whitespace-only string field as absent', () => {
    expect(parseNftOffchainMetadata({ name: '   ', description: '' })).toBeNull();
  });

  it('ignores a collection object with no usable fields', () => {
    expect(parseNftOffchainMetadata({ name: 'N', collection: { attributes: 'not-an-array' } })?.collection).toBeNull();
  });

  it('treats a non-boolean sensitive_content as false (never fails closed to "safe" by trusting a truthy garbage value)', () => {
    expect(parseNftOffchainMetadata({ name: 'N', sensitive_content: 'yes' })?.sensitiveContent).toBe(false);
    expect(parseNftOffchainMetadata({ name: 'N', sensitive_content: true })?.sensitiveContent).toBe(true);
  });

  it('rejects a negative or non-finite series_number/series_total', () => {
    const parsed = parseNftOffchainMetadata({ name: 'N', series_number: -1, series_total: Infinity });
    expect(parsed?.seriesNumber).toBeNull();
    expect(parsed?.seriesTotal).toBeNull();
  });
});

describe('decodeDataUriJson', () => {
  it('decodes a base64 data: URI', () => {
    const json = JSON.stringify({ name: 'X' });
    const uri = `data:application/json;base64,${btoa(json)}`;
    expect(decodeDataUriJson(uri)).toEqual({ name: 'X' });
  });

  it('decodes a percent-encoded plain data: URI', () => {
    const uri = `data:application/json,${encodeURIComponent(JSON.stringify({ name: 'Y' }))}`;
    expect(decodeDataUriJson(uri)).toEqual({ name: 'Y' });
  });

  it('returns null for a malformed data: URI', () => {
    expect(decodeDataUriJson('not-a-data-uri')).toBeNull();
    expect(decodeDataUriJson('data:application/json;base64,***not-base64***')).toBeNull();
    expect(decodeDataUriJson('data:application/json,not valid json')).toBeNull();
  });
});
