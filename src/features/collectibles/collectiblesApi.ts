import { api } from '@/api/api';
import { ACTIONS } from '@/lib/messages';
import type { WalletNft, NftTransferSummary, NftMintSummary } from '@/offscreen/nfts';
import type { WireNftMintParams } from '@/offscreen/vault';
import type { NftDidAssignSummary } from '@/offscreen/didAssign';

/**
 * Collectibles (NFTs) endpoints (#56) — routed over the SW seam (`chromeBaseQuery` →
 * `chrome.runtime.sendMessage` → the background SW → the offscreen keystore vault), like the other
 * self-custody surfaces. The decrypted key never crosses this boundary. Transfer + DID-assignment
 * reuse the send machinery: `confirmNftTransfer`/`confirmNftDidAssign` map to the vault's
 * `confirmSend` broadcast path, and confirmation is polled with the shared `sendStatus` (custodyApi's
 * `useLazySendStatusQuery`). Injects into the single `api` slice.
 */

export type { WalletNft, NftTransferSummary, NftMintSummary } from '@/offscreen/nfts';
export type { WireNftMintParams } from '@/offscreen/vault';
export type { NftDidAssignSummary } from '@/offscreen/didAssign';

export const collectiblesApi = api.injectEndpoints({
  endpoints: (build) => ({
    // Discover the wallet's NFTs (both HD schemes, by hint). Read-only.
    listCollectibles: build.query<{ nfts: WalletNft[]; cached?: boolean }, void>({
      query: () => ({ action: ACTIONS.listNfts }),
      providesTags: ['Collectibles'],
    }),

    // Build (not broadcast) an NFT transfer → the pending id + decoded summary to approve.
    prepareNftTransfer: build.mutation<
      { pendingId: string; nftSummary: NftTransferSummary },
      { launcherId: string; recipient: string; fee?: string }
    >({
      query: (arg) => ({ action: ACTIONS.prepareNftTransfer, ...arg }),
    }),

    // Sign + BROADCAST a prepared NFT transfer (the approved step). Invalidates collectibles + ledger.
    confirmNftTransfer: build.mutation<{ spentCoinId: string }, { pendingId: string }>({
      query: (arg) => ({ action: ACTIONS.confirmNftTransfer, ...arg }),
      invalidatesTags: ['Collectibles', 'Activity', 'Balances'],
    }),

    // Build (not broadcast) a new-NFT mint (#92) → the pending id + launcher id + decoded summary.
    prepareNftMint: build.mutation<
      { pendingId: string; launcherId: string; nftMintSummary: NftMintSummary },
      { nftMint: WireNftMintParams }
    >({
      query: (arg) => ({ action: ACTIONS.prepareNftMint, ...arg }),
    }),

    // Sign + BROADCAST a prepared NFT mint (the approved step). Invalidates collectibles + ledger.
    confirmNftMint: build.mutation<{ spentCoinId: string }, { pendingId: string }>({
      query: (arg) => ({ action: ACTIONS.confirmNftMint, ...arg }),
      invalidatesTags: ['Collectibles', 'Activity', 'Balances'],
    }),

    // Build (not broadcast) assigning an owned DID as this NFT's owner (#93) → pending id + summary.
    prepareNftDidAssign: build.mutation<
      { pendingId: string; nftDidAssignSummary: NftDidAssignSummary },
      { launcherId: string; didLauncherId: string; fee?: string }
    >({
      query: (arg) => ({ action: ACTIONS.prepareNftDidAssign, ...arg }),
    }),

    // Sign + BROADCAST a prepared NFT↔DID assignment (the approved step). Invalidates collectibles +
    // identity (the DID's on-chain state didn't change, but the assignment reads its list) + ledger.
    confirmNftDidAssign: build.mutation<{ spentCoinId: string }, { pendingId: string }>({
      query: (arg) => ({ action: ACTIONS.confirmNftDidAssign, ...arg }),
      invalidatesTags: ['Collectibles', 'Identity', 'Activity', 'Balances'],
    }),
  }),
  overrideExisting: false,
});

export const {
  useListCollectiblesQuery,
  usePrepareNftTransferMutation,
  useConfirmNftTransferMutation,
  usePrepareNftMintMutation,
  useConfirmNftMintMutation,
  usePrepareNftDidAssignMutation,
  useConfirmNftDidAssignMutation,
} = collectiblesApi;
