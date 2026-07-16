import { createApi, fakeBaseQuery } from '@reduxjs/toolkit/query/react';
import { fetchFeedComponents, type FeedComponentVersion } from '@/lib/feed-manifest';
import type { UpdateChannel } from '@/lib/updater-channel';

/**
 * Update-feed manifest RTK Query slice (#583) — a SEPARATE api slice from the SW-seam `api` slice,
 * exactly like `priceApi`/`catMetadataApi`: the feed manifest is public, read-only data fetched
 * DIRECTLY over HTTPS (`updates.dig.net`, covered by the extension CSP `connect-src`'s `https://*.dig.net`)
 * with no local-node routing or custody concern, so it does not belong on the SW/offscreen-vault
 * transport `chromeBaseQuery` speaks.
 *
 * CACHE TTL — the beacon re-signs the feed every ~6h (dig-updater SPEC §5.3) and a new release lands
 * at most a few times a day, so a moderate TTL avoids re-hammering the feed on every popup open while
 * still keeping the Updates tab's out-of-date badge fresh within the hour.
 */
export const FEED_MANIFEST_TTL_SECONDS = 30 * 60; // 30 minutes

export const feedManifestApi = createApi({
  reducerPath: 'feedManifestApi',
  baseQuery: fakeBaseQuery<{ message: string }>(),
  tagTypes: ['FeedManifest'],
  keepUnusedDataFor: FEED_MANIFEST_TTL_SECONDS,
  refetchOnMountOrArgChange: FEED_MANIFEST_TTL_SECONDS,
  endpoints: (build) => ({
    // Keyed by the beacon's tracked channel (#606): the out-of-date badge must compare the running
    // build against the SAME stream the node auto-updates from, so a nightly node isn't flagged
    // "out of date" against the stable feed (and vice-versa). RTK caches one entry per channel arg.
    getFeedManifest: build.query<FeedComponentVersion[], UpdateChannel>({
      queryFn: async (channel) => {
        try {
          return { data: await fetchFeedComponents(channel) };
        } catch (e) {
          return { error: { message: e instanceof Error ? e.message : 'Update feed unavailable' } };
        }
      },
      providesTags: ['FeedManifest'],
    }),
  }),
});

export const { useGetFeedManifestQuery } = feedManifestApi;
