import { api } from '@/api/api';
import { ACTIONS } from '@/lib/messages';
import type { WalletSyncStatus } from '@/lib/dig-node-wallet-ws';

/**
 * Wallet sync-status query (#372/#373): reads the SW-cached tri-state the dig-node pushes over the
 * `/ws` wallet+control transport (SPEC §4.8). The wallet UI hydrates from this on mount;
 * `controlPanelSync` then live-patches this cache entry from the SW's `walletSyncStatusChanged`
 * broadcast, so the "Syncing (peak/target)" / disconnected banner flips with no polling.
 */
export const walletSyncApi = api.injectEndpoints({
  endpoints: (build) => ({
    getWalletSyncStatus: build.query<WalletSyncStatus, void>({
      query: () => ({ action: ACTIONS.getWalletSyncStatus }),
      providesTags: ['WalletSyncStatus'],
    }),
  }),
  overrideExisting: false,
});

export const { useGetWalletSyncStatusQuery } = walletSyncApi;
