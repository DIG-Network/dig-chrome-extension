import { createApi } from '@reduxjs/toolkit/query/react';
import { chromeBaseQuery } from '@/api/baseQuery';

/** RTK Query cache tags — mutations invalidate, queries provide (§6.4 tag-driven cache). */
export const TAGS = [
  'Balances',
  'Activity',
  'NodeStatus',
  // Wallet-data source auto-detect (#222): the §5.3 ladder status for the WALLET read path.
  'ChainSourceStatus',
  // dig-dns Path-B proxy fallback (#175): the shared `.dig`-resolution availability signal.
  'DigDnsStatus',
  'Shield',
  'Control',
  // dig-node control panel (#278/#281): the live node status, the OPEN cache/LRU surface, the
  // control-token pairing state, and the token-gated management surfaces.
  'NodeLiveStatus',
  // Thin-client wallet sync status (#372/#373): the /ws-pushed syncing|synced|disconnected state.
  'WalletSyncStatus',
  'Cache',
  'Pairing',
  'Upstream',
  'HostedStores',
  'Sync',
  'Peers',
  // Self-custody (#56): lock state + derived receive addresses.
  'LockState',
  'Address',
  // Multi-wallet switcher (#90): the wallet registry metadata list.
  'Wallets',
  // Self-custody NFTs / Collectibles (#56).
  'Collectibles',
  // Self-custody DID management (#93).
  'Identity',
  // Coin control (#91): the per-asset unspent-coin list.
  'Coins',
  // Self-custody dApp approval queue (#56 §5.5): the pending window.chia signing requests.
  'DappApprovals',
  // Connected sites / granular permissions (#67 P0-4): the origins the wallet is connected to.
  'ConnectedSites',
  // Clawback (#152): the pending incoming/outgoing clawback list.
  'Clawbacks',
  // Trade offers (#101): the local "your offers" log (made offers + derived status).
  'Offers',
  // Option contracts (#104): the local minted-option registry (mint + derived status).
  'Options',
] as const;

/**
 * The single RTK Query API slice. Endpoints are split per feature via `injectEndpoints` so each
 * feature owns its own query/mutation surface. Server/broker cache lives HERE (never duplicated
 * into a slice); cross-document convergence is handled by the SW cache + broadcast invalidation
 * (the pure `@/lib/sw-cache` mechanism) in later wiring — Phase 0 ships the seam.
 */
export const api = createApi({
  reducerPath: 'api',
  baseQuery: chromeBaseQuery,
  tagTypes: TAGS,
  endpoints: () => ({}),
});
