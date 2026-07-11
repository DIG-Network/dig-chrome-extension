import { api } from '@/api/api';
import { ACTIONS } from '@/lib/messages';

/**
 * Peers (#393) — the extension-side view + management surface for the dig-node's peer set. The
 * dig-node OWNS peer management (dig-nat + dig-gossip AddressManager); the extension is a FRONTEND
 * driving it over the token-gated `control.*` RPC surface (#280/#281), consistent with the
 * thin-client model (#365).
 *
 * NODE-SIDE GAP (flagged for a dig-node follow-up — release-first, single-writer):
 * today the node exposes ONLY `control.peerStatus`, which returns a running flag + a connected
 * count. It does NOT yet return a per-peer LIST, a ban list, or a pool config, and there are no
 * peer-management RPCs. This slice names the management methods it will drive so the UI is wired +
 * forward-compatible; until the node implements them (and advertises `management_supported`) the
 * calls fail and the UI keeps the management controls disabled with an honest note. When the node
 * ships these methods it lights up with no extension change.
 */
export const UNIMPLEMENTED_NODE_PEER_RPCS = Object.freeze([
  'control.peers.connect', // { peer } — dial a peer by address/peer_id
  'control.peers.disconnect', // { peer } — drop a connected peer
  'control.peers.setBan', // { peer, state: 'ban' | 'blacklist' | 'none' } — block/allow a peer
  'control.peers.setPoolConfig', // { max_connections } — pool caps (dig-gossip AddressManager)
  // and an extended `control.peerStatus` returning `peers[]` + `bans[]` + `pool` + capability flags.
]);

/** One peer the node is connected to. Addresses are IPv6-first per §5.2. */
export interface PeerInfo {
  peer_id: string;
  addresses?: string[];
  connection_type?: 'direct' | 'hole_punched' | 'relayed';
  direction?: 'inbound' | 'outbound';
  latency_ms?: number | null;
  uptime_secs?: number | null;
}

/**
 * The (forward-compatible) `control.peerStatus` payload. Today's node fills only `running` +
 * `connected_peers`; the optional fields are populated by a future node build — the UI renders
 * whatever is present and degrades honestly (a "needs a newer node" note) for what is absent.
 */
export interface PeerStatusResponse {
  running?: boolean;
  connected_peers?: number;
  peers?: PeerInfo[];
  bans?: string[];
  max_connections?: number | null;
  /** True once the node implements the peer-management RPCs above; gates the management controls. */
  management_supported?: boolean;
}

/** Blacklist = soft (don't dial/prefer); ban = hard (refuse connections); none = clear. */
export type BanState = 'ban' | 'blacklist' | 'none';

export const peersApi = api.injectEndpoints({
  endpoints: (build) => ({
    /** Live peer status/list (control.peerStatus). Token-gated → pair the node to read it (#281). */
    getPeers: build.query<PeerStatusResponse, void>({
      query: () => ({ action: ACTIONS.controlAuthed, method: 'control.peerStatus' }),
      providesTags: ['Peers'],
    }),
    /** Manually dial a peer by address or peer_id (control.peers.connect). */
    connectPeer: build.mutation<unknown, { peer: string }>({
      query: ({ peer }) => ({ action: ACTIONS.controlAuthed, method: 'control.peers.connect', params: { peer } }),
      invalidatesTags: ['Peers'],
    }),
    /** Drop a connected peer (control.peers.disconnect). */
    disconnectPeer: build.mutation<unknown, { peer: string }>({
      query: ({ peer }) => ({ action: ACTIONS.controlAuthed, method: 'control.peers.disconnect', params: { peer } }),
      invalidatesTags: ['Peers'],
    }),
    /** Blacklist (soft) / ban (hard) / clear a peer (control.peers.setBan). */
    setPeerBan: build.mutation<unknown, { peer: string; state: BanState }>({
      query: ({ peer, state }) => ({ action: ACTIONS.controlAuthed, method: 'control.peers.setBan', params: { peer, state } }),
      invalidatesTags: ['Peers'],
    }),
    /** Set the peer-pool max connections (control.peers.setPoolConfig). */
    setPoolConfig: build.mutation<unknown, { max_connections: number }>({
      query: ({ max_connections }) => ({
        action: ACTIONS.controlAuthed,
        method: 'control.peers.setPoolConfig',
        params: { max_connections },
      }),
      invalidatesTags: ['Peers'],
    }),
  }),
  overrideExisting: false,
});

export const {
  useGetPeersQuery,
  useConnectPeerMutation,
  useDisconnectPeerMutation,
  useSetPeerBanMutation,
  useSetPoolConfigMutation,
} = peersApi;
