import { api } from '@/api/api';
import { ACTIONS } from '@/lib/messages';
import type { NodeLiveStatus } from '@/lib/dig-node-ws';

/**
 * Live node-status query (#239): reads the SW-cached WS `/ws/status` snapshot. The popup hydrates
 * from this on mount; `controlPanelSync` then live-patches this cache entry from the SW's
 * `nodeLiveStatusChanged` broadcast, so the indicator flips online/offline with no polling.
 */
export const nodeApi = api.injectEndpoints({
  endpoints: (build) => ({
    getNodeLiveStatus: build.query<NodeLiveStatus, void>({
      query: () => ({ action: ACTIONS.getNodeLiveStatus }),
      providesTags: ['NodeLiveStatus'],
    }),
  }),
  overrideExisting: false,
});

export const { useGetNodeLiveStatusQuery } = nodeApi;
