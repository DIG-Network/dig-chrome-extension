import { api } from '@/api/api';
import { ACTIONS } from '#shared/messages.mjs';
import type { WalletNft, NftTransferSummary } from '@/offscreen/nfts';

/**
 * Collectibles (NFTs) endpoints (#56) — routed over the SW seam (`chromeBaseQuery` →
 * `chrome.runtime.sendMessage` → the background SW → the offscreen keystore vault), like the other
 * self-custody surfaces. The decrypted key never crosses this boundary. Transfer reuses the send
 * machinery: `confirmNftTransfer` maps to the vault's `confirmSend` broadcast path, and confirmation
 * is polled with the shared `sendStatus` (custodyApi's `useLazySendStatusQuery`). Injects into the
 * single `api` slice.
 */

export type { WalletNft, NftTransferSummary } from '@/offscreen/nfts';

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
  }),
  overrideExisting: false,
});

export const {
  useListCollectiblesQuery,
  usePrepareNftTransferMutation,
  useConfirmNftTransferMutation,
} = collectiblesApi;
