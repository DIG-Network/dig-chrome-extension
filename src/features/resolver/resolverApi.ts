import { api } from '@/api/api';
import { ACTIONS } from '@/lib/messages';
import type { DigDnsSnapshot } from '@/lib/dig-dns';

/** `getDigNodeStatus` probe result — whether a local node answered and which base won. */
export interface NodeStatus {
  reachable: boolean;
  base: string | null;
}

export const resolverApi = api.injectEndpoints({
  endpoints: (build) => ({
    getNodeStatus: build.query<NodeStatus, void>({
      query: () => ({ action: ACTIONS.getDigNodeStatus }),
      providesTags: ['NodeStatus'],
    }),
    saveNodeHost: build.mutation<unknown, { host: string }>({
      query: ({ host }) => ({ action: ACTIONS.updateServerConfig, host }),
      invalidatesTags: ['NodeStatus'],
    }),
    // dig-dns Path-B proxy fallback (#175): the shared `.dig`-resolution availability signal —
    // polled by the Resolver tab's indicator (see ResolverTab.tsx); #172 reads the same action.
    getDigDnsStatus: build.query<DigDnsSnapshot, void>({
      query: () => ({ action: ACTIONS.getDigDnsStatus }),
      providesTags: ['DigDnsStatus'],
    }),
  }),
  overrideExisting: false,
});

export const { useGetNodeStatusQuery, useSaveNodeHostMutation, useGetDigDnsStatusQuery } = resolverApi;
