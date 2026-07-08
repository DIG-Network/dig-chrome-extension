import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { WalletNft } from '@/offscreen/nfts';
import { useNftMetadata } from '@/features/collectibles/useNftMetadata';
import { resetSharedNftMetadataCacheForTests } from '@/features/collectibles/nftMetadataCache';

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

function mockSendMessage(reply: unknown) {
  const fn = vi.fn((_msg: unknown, cb?: (r: unknown) => void) => {
    if (cb) cb(reply);
    return Promise.resolve(reply);
  });
  (chrome.runtime as unknown as { sendMessage: typeof fn }).sendMessage = fn;
  return fn;
}

beforeEach(async () => {
  resetSharedNftMetadataCacheForTests();
  await chrome.storage.local.remove('digNftMetadataCache');
});
afterEach(() => vi.restoreAllMocks());

describe('useNftMetadata (#98)', () => {
  it('is idle (no metadata, not loading) for an NFT with no usable metadataUri', () => {
    const send = mockSendMessage({ metadata: { name: 'unused' } });
    const { result } = renderHook(() => useNftMetadata(nft({ metadataUris: [] })));
    expect(result.current).toEqual({ metadata: null, isLoading: false });
    expect(send).not.toHaveBeenCalled();
  });

  it('decodes a data: metadataUri inline, with no chrome.runtime round trip', () => {
    const send = mockSendMessage({ metadata: { name: 'unused' } });
    const doc = { name: 'Inline NFT' };
    const uri = `data:application/json;base64,${btoa(JSON.stringify(doc))}`;
    const { result } = renderHook(() => useNftMetadata(nft({ metadataUris: [uri] })));
    expect(result.current.isLoading).toBe(false);
    expect(result.current.metadata?.name).toBe('Inline NFT');
    expect(send).not.toHaveBeenCalled();
  });

  it('fetches + parses a remote metadataUri, loading then resolved', async () => {
    mockSendMessage({ metadata: { name: 'Remote NFT', attributes: [{ trait_type: 'Eyes', value: 'Blue' }] } });
    const { result } = renderHook(() => useNftMetadata(nft({ metadataUris: ['https://example.test/meta.json'] })));
    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.metadata?.name).toBe('Remote NFT');
    expect(result.current.metadata?.attributes).toEqual([{ traitType: 'Eyes', value: 'Blue' }]);
  });

  it('resolves metadata: null (never throws) on a fetch failure', async () => {
    mockSendMessage({ success: false, code: 'NETWORK_ERROR', message: 'boom' });
    const { result } = renderHook(() => useNftMetadata(nft({ metadataUris: ['https://example.test/meta.json'] })));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.metadata).toBeNull();
  });

  it('a second render for the SAME nft reuses the cache — no second sendMessage call', async () => {
    const send = mockSendMessage({ metadata: { name: 'Cached NFT' } });
    const target = nft({ metadataUris: ['https://example.test/meta.json'] });
    const { result, rerender } = renderHook(() => useNftMetadata(target));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(send).toHaveBeenCalledTimes(1);
    rerender();
    await waitFor(() => expect(result.current.metadata?.name).toBe('Cached NFT'));
    expect(send).toHaveBeenCalledTimes(1);
  });
});
