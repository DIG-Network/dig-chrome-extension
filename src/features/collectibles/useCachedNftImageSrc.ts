import { useEffect, useState } from 'react';
import { getSharedNftImageCache } from '@/features/collectibles/nftImageCache';

/**
 * Resolve an NFT image source (`nftImageSrc` — `data:` inline or a remote `http(s)`/gateway-rewritten
 * `ipfs://` URL, #150) to what `<img src>` should actually render: a `data:` URI passes through
 * unchanged (already inline, no network cost); a remote URL is served through the local NFT image
 * cache (#159) — a cache hit resolves immediately with NO re-fetch, a miss fetches once, caches the
 * bytes, and resolves to an object URL.
 *
 * A cache/fetch failure falls back to the RAW remote URL (uncached, exactly the pre-#159 behavior) —
 * NOT to the monogram — because `fetch()` (unlike an `<img>` load) is subject to CORS, and plenty of
 * real NFT-art hosts (marketplace CDNs, some IPFS gateways) render fine as an `<img src>` without ever
 * sending `Access-Control-Allow-Origin`. Failing closed to the monogram here would regress #150 for
 * every such host. `NftMedia`'s existing `<img onerror>` handling still catches a genuinely dead host
 * (a real 404/timeout fails identically whether requested via `fetch()` or `<img src>`).
 *
 * Returns null only while still resolving (`NftMedia` shows the monogram placeholder meanwhile, same
 * as "no image yet"). Extracted from `NftDetail.tsx` (#98) so `CollectiblesPanel.tsx`'s collection
 * group banner can reuse the exact same resolved/cached source without a second implementation.
 */
export function useCachedNftImageSrc(imageSrc: string | null): string | null {
  const [resolved, setResolved] = useState<string | null>(null);
  useEffect(() => {
    if (!imageSrc) {
      setResolved(null);
      return;
    }
    if (imageSrc.startsWith('data:')) {
      setResolved(imageSrc);
      return;
    }
    let cancelled = false;
    setResolved(null);
    getSharedNftImageCache()
      .getOrFetchObjectUrl(imageSrc)
      .then((src) => {
        if (!cancelled) setResolved(src);
      })
      .catch(() => {
        if (!cancelled) setResolved(imageSrc); // graceful, uncached fallback — see doc comment above
      });
    return () => {
      cancelled = true;
    };
  }, [imageSrc]);
  return resolved;
}
