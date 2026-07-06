import { api } from '@/api/api';
import { ACTIONS } from '@/lib/messages';
import type { OriginPermission } from '@/lib/wallet-broker';

/**
 * Connected-sites endpoints (#67 P0-4) — the Settings/Advanced screen ↔ SW channel over the
 * `chromeBaseQuery` seam. The list query reads every origin the wallet is connected to (as an
 * EIP-2255-shaped capability record); the revoke mutations clear one / all origins' consent and
 * invalidate the list so a revoked site disappears immediately (and must re-request to reconnect).
 */

/** The connected-sites snapshot the settings screen renders. */
export interface ConnectedSitesResponse {
  sites: OriginPermission[];
}

export const connectedSitesApi = api.injectEndpoints({
  endpoints: (build) => ({
    getConnectedSites: build.query<ConnectedSitesResponse, void>({
      query: () => ({ action: ACTIONS.listConnectedSites }),
      providesTags: ['ConnectedSites'],
    }),
    revokeConnectedSite: build.mutation<{ success: boolean }, { origin: string }>({
      query: (arg) => ({ action: ACTIONS.revokeConnectedSite, origin: arg.origin }),
      invalidatesTags: ['ConnectedSites'],
    }),
    revokeAllConnectedSites: build.mutation<{ success: boolean }, void>({
      query: () => ({ action: ACTIONS.revokeAllConnectedSites }),
      invalidatesTags: ['ConnectedSites'],
    }),
  }),
  overrideExisting: false,
});

export const {
  useGetConnectedSitesQuery,
  useRevokeConnectedSiteMutation,
  useRevokeAllConnectedSitesMutation,
} = connectedSitesApi;
