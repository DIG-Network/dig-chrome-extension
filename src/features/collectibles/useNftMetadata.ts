import { useEffect, useState } from 'react';
import { ACTIONS } from '@/lib/messages';
import type { WalletNft } from '@/offscreen/nfts';
import { nftMetadataUri } from '@/features/collectibles/nftDisplay';
import { decodeDataUriJson, parseNftOffchainMetadata, type NftOffchainMetadata } from '@/lib/nft-offchain-metadata';
import { getSharedNftMetadataCache, type NftMetadataFetchResult } from '@/features/collectibles/nftMetadataCache';

/** The `getNftMetadata` round trip the shared cache uses on a miss (`src/lib/messages.ts`). */
function fetchNftMetadataJson(uri: string): Promise<NftMetadataFetchResult> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: ACTIONS.getNftMetadata, uri }, (reply: NftMetadataFetchResult) => resolve(reply));
  });
}

/**
 * Resolve an NFT's off-chain CHIP-0007 metadata (#98) — the real name/description/attributes/
 * collection §18.11c's `parseNftOffchainMetadata` decodes. A `data:` `metadataUri` decodes inline
 * (no network); a remote one goes through the shared, cached `getNftMetadata` round trip
 * (`nftMetadataCache.ts`) — a cache hit resolves with no `chrome.runtime` call at all.
 *
 * No explicit error state, mirroring `NftMedia`'s existing graceful degradation for third-party NFT
 * content (`NftDetail.tsx`): a failure (network error, invalid JSON, no usable fields, no
 * `metadataUris` at all) simply resolves `metadata: null`, and the caller falls back to the
 * on-chain-only display exactly as if no off-chain document existed.
 */
export function useNftMetadata(nft: WalletNft): { metadata: NftOffchainMetadata | null; isLoading: boolean } {
  const [metadata, setMetadata] = useState<NftOffchainMetadata | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  // A stable primitive key (not the `nft` object identity, which may change reference every poll
  // even when the URIs themselves didn't) — the effect re-runs only when the URIs actually change.
  const metadataUrisKey = nft.metadataUris.join('|');

  useEffect(() => {
    setMetadata(null);
    const resolved = nftMetadataUri(nft);
    if (!resolved) {
      setIsLoading(false);
      return;
    }
    if (resolved.kind === 'data') {
      setMetadata(parseNftOffchainMetadata(decodeDataUriJson(resolved.uri)));
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    getSharedNftMetadataCache(fetchNftMetadataJson)
      .getOrFetch(resolved.url)
      .then((raw) => {
        if (!cancelled) setMetadata(parseNftOffchainMetadata(raw));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // `nft` itself is intentionally not a dep — metadataUrisKey already captures the only field this
    // effect reads that can meaningfully change (see the comment above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metadataUrisKey]);

  return { metadata, isLoading };
}
