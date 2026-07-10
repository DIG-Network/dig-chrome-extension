import { api } from '@/api/api';
import { ACTIONS } from '@/lib/messages';

/** `getControlStatus` — the raw node-detection + best-effort control.status payload. */
export interface ControlStatusResponse {
  mode: 'manage' | 'install';
  localNode: boolean;
  base: string | null;
  controlEndpoint: string | null;
  readFallback: string;
  status: Record<string, unknown> | null;
  authRequired: boolean;
  controlMethods: string[];
}

/** The node config (`control.config.get`) — only the fields the panel reads. */
export interface NodeConfig {
  upstream?: string;
  upstream_override?: string | null;
  addr?: string;
  cache_dir?: string;
  [k: string]: unknown;
}

/** One hosted/pinned store (`control.hostedStores.list`). */
export interface HostedStore {
  store_id: string;
  pinned: boolean;
  capsule_count: number;
  total_bytes: number;
  capsules?: unknown[];
}

/** §21 sync status (`control.sync.status`). */
export interface SyncStatus {
  available: boolean;
  method?: string;
  pinned_total?: number;
  pinned_synced?: number;
  [k: string]: unknown;
}

/**
 * The token-gated `control.*` management surface (#281). Every endpoint routes through the SW's
 * `controlAuthed` action, which attaches the stored paired token; an unauthorized/revoked token
 * surfaces as an RTK error (the SW also clears it, dropping the panel back to "pair to manage").
 * Mutations invalidate the matching tag so the section re-reads after a change.
 */
export const controlApi = api.injectEndpoints({
  endpoints: (build) => ({
    getControlStatus: build.query<ControlStatusResponse, void>({
      query: () => ({ action: ACTIONS.getControlStatus }),
      providesTags: ['Control'],
    }),

    // Upstream (control.config.get / setUpstream)
    getNodeConfig: build.query<NodeConfig, void>({
      query: () => ({ action: ACTIONS.controlAuthed, method: 'control.config.get' }),
      providesTags: ['Upstream'],
    }),
    setUpstream: build.mutation<{ upstream: string; requires_restart?: boolean }, { upstream: string }>({
      query: ({ upstream }) => ({ action: ACTIONS.controlAuthed, method: 'control.config.setUpstream', params: { upstream } }),
      invalidatesTags: ['Upstream', 'Control'],
    }),

    // Hosted stores (control.hostedStores.*)
    listHostedStores: build.query<{ stores: HostedStore[] }, void>({
      query: () => ({ action: ACTIONS.controlAuthed, method: 'control.hostedStores.list' }),
      providesTags: ['HostedStores'],
    }),
    pinStore: build.mutation<unknown, { store: string }>({
      query: ({ store }) => ({ action: ACTIONS.controlAuthed, method: 'control.hostedStores.pin', params: { store } }),
      invalidatesTags: ['HostedStores', 'Cache'],
    }),
    unpinStore: build.mutation<unknown, { store: string }>({
      query: ({ store }) => ({ action: ACTIONS.controlAuthed, method: 'control.hostedStores.unpin', params: { store } }),
      invalidatesTags: ['HostedStores', 'Cache'],
    }),

    // §21 sync (control.sync.*)
    getSyncStatus: build.query<SyncStatus, void>({
      query: () => ({ action: ACTIONS.controlAuthed, method: 'control.sync.status' }),
      providesTags: ['Sync'],
    }),
    triggerSync: build.mutation<unknown, { store: string }>({
      query: ({ store }) => ({ action: ACTIONS.controlAuthed, method: 'control.sync.trigger', params: { store } }),
      invalidatesTags: ['Sync', 'HostedStores', 'Cache'],
    }),

    // Peers (control.peerStatus)
    getPeerStatus: build.query<Record<string, unknown>, void>({
      query: () => ({ action: ACTIONS.controlAuthed, method: 'control.peerStatus' }),
      providesTags: ['Peers'],
    }),
  }),
  overrideExisting: false,
});

export const {
  useGetControlStatusQuery,
  useGetNodeConfigQuery,
  useSetUpstreamMutation,
  useListHostedStoresQuery,
  usePinStoreMutation,
  useUnpinStoreMutation,
  useGetSyncStatusQuery,
  useTriggerSyncMutation,
  useGetPeerStatusQuery,
} = controlApi;
