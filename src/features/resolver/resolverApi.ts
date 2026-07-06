import { api } from '@/api/api';
import { ACTIONS } from '@/lib/messages';

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
  }),
  overrideExisting: false,
});

export const { useGetNodeStatusQuery, useSaveNodeHostMutation } = resolverApi;
