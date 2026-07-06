import { createApi } from '@reduxjs/toolkit/query/react';
import { chromeBaseQuery } from '@/api/baseQuery';

/** RTK Query cache tags — mutations invalidate, queries provide (§6.4 tag-driven cache). */
export const TAGS = [
  'Balances',
  'Activity',
  'NodeStatus',
  'Shield',
  'Control',
  // Self-custody (#56): lock state + derived receive addresses.
  'LockState',
  'Address',
  // Multi-wallet switcher (#90): the wallet registry metadata list.
  'Wallets',
  // Self-custody NFTs / Collectibles (#56).
  'Collectibles',
  // Coin control (#91): the per-asset unspent-coin list.
  'Coins',
  // Self-custody dApp approval queue (#56 §5.5): the pending window.chia signing requests.
  'DappApprovals',
  // Connected sites / granular permissions (#67 P0-4): the origins the wallet is connected to.
  'ConnectedSites',
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
