import { createApi, fakeBaseQuery } from '@reduxjs/toolkit/query/react';
import { fetchFeeEstimate, type FeeEstimateResult } from '@/features/wallet/custody/feeEstimate';
import { resolveCoinsetUrl } from '@/lib/custody-session';
import { readWalletSettings } from '@/features/wallet/custody/settings';

/**
 * Network-fee-estimate RTK Query slice (#206/#110) — a SEPARATE api slice from the SW-seam `api`
 * slice (like `priceApi`/`catMetadataApi`), because a fee estimate is PUBLIC, read-only full-node
 * data fetched DIRECTLY over HTTPS from coinset.org (`api.coinset.org`, allowed by the extension
 * `host_permissions` + CSP `connect-src`) — a different transport from the custody service-worker
 * seam. There is no sensitive data here, so it deliberately does NOT route through the SW/offscreen
 * vault.
 *
 * The endpoint URL follows the §5.3 node-first ladder via `resolveCoinsetUrl` (the same override the
 * balance scan uses): an explicit custom-node override wins, else the coinset default. A node that
 * lacks `get_fee_estimate` simply errors → the UI falls back to a sane default fee + manual override
 * (honest, never a spinner-forever — §6.4 four states).
 *
 * SHORT TTL — fee conditions move with mempool congestion, so this is treated stale after
 * {@link FEE_TTL_SECONDS} and refetched on a remount; brief caching stops the popup re-hammering the
 * endpoint on every open.
 */

/** Refetch a fee estimate older than this (seconds) on a remount; keep it cached this long unsubscribed. */
export const FEE_TTL_SECONDS = 60;

export const feeApi = createApi({
  reducerPath: 'feeApi',
  baseQuery: fakeBaseQuery<{ message: string }>(),
  tagTypes: ['Fee'],
  keepUnusedDataFor: FEE_TTL_SECONDS,
  refetchOnMountOrArgChange: FEE_TTL_SECONDS,
  endpoints: (build) => ({
    // An optional explicit `cost` prices the fee for a specific spend; omitted uses the nominal
    // send cost (the fee is chosen on the form, before the real spend is built).
    getFeeEstimate: build.query<FeeEstimateResult, { cost?: number } | void>({
      queryFn: async (arg) => {
        try {
          const baseUrl = resolveCoinsetUrl(await readWalletSettings());
          return { data: await fetchFeeEstimate(fetch, baseUrl, arg?.cost) };
        } catch (e) {
          return { error: { message: e instanceof Error ? e.message : 'Fee estimate unavailable' } };
        }
      },
      providesTags: ['Fee'],
    }),
  }),
});

export const { useGetFeeEstimateQuery } = feeApi;
