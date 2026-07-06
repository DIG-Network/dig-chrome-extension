import { api } from '@/api/api';
import { ACTIONS } from '@/lib/messages';
import type { WalletDid, DidCreateSummary, DidTransferSummary, DidProfileUpdateSummary } from '@/offscreen/dids';

/**
 * DID management endpoints (#93) — routed over the SW seam (`chromeBaseQuery` →
 * `chrome.runtime.sendMessage` → the background SW → the offscreen keystore vault), like the other
 * self-custody surfaces. The decrypted key never crosses this boundary. Create/transfer/profile-update
 * reuse the send machinery: `confirmDidCreate`/`confirmDidTransfer`/`confirmDidProfileUpdate` map to
 * the vault's `confirmSend` broadcast path, and confirmation is polled with the shared `sendStatus`
 * (custodyApi's `useLazySendStatusQuery`). Injects into the single `api` slice.
 */

export type { WalletDid, DidCreateSummary, DidTransferSummary, DidProfileUpdateSummary } from '@/offscreen/dids';

export const identityApi = api.injectEndpoints({
  endpoints: (build) => ({
    // Discover the wallet's DIDs (both HD schemes, by hint). Read-only.
    listDids: build.query<{ dids: WalletDid[] }, void>({
      query: () => ({ action: ACTIONS.listDids }),
      providesTags: ['Identity'],
    }),

    // Build (not broadcast) a new "simple" DID (#93) → the pending id + launcher id + decoded summary.
    prepareDidCreate: build.mutation<
      { pendingId: string; launcherId: string; didCreateSummary: DidCreateSummary },
      { fee?: string }
    >({
      query: (arg) => ({ action: ACTIONS.prepareDidCreate, ...arg }),
    }),

    // Sign + BROADCAST a prepared DID create (the approved step). Invalidates identity + ledger.
    confirmDidCreate: build.mutation<{ spentCoinId: string }, { pendingId: string }>({
      query: (arg) => ({ action: ACTIONS.confirmDidCreate, ...arg }),
      invalidatesTags: ['Identity', 'Activity', 'Balances'],
    }),

    // Build (not broadcast) a DID transfer → the pending id + decoded summary to approve.
    prepareDidTransfer: build.mutation<
      { pendingId: string; didSummary: DidTransferSummary },
      { launcherId: string; recipient: string; fee?: string }
    >({
      query: (arg) => ({ action: ACTIONS.prepareDidTransfer, ...arg }),
    }),

    // Sign + BROADCAST a prepared DID transfer (the approved step). Invalidates identity + ledger.
    confirmDidTransfer: build.mutation<{ spentCoinId: string }, { pendingId: string }>({
      query: (arg) => ({ action: ACTIONS.confirmDidTransfer, ...arg }),
      invalidatesTags: ['Identity', 'Activity', 'Balances'],
    }),

    // Build (not broadcast) a DID profile (metadata) update → the pending id + decoded summary.
    prepareDidProfileUpdate: build.mutation<
      { pendingId: string; didProfileSummary: DidProfileUpdateSummary },
      { launcherId: string; profileName: string; fee?: string }
    >({
      query: (arg) => ({ action: ACTIONS.prepareDidProfileUpdate, ...arg }),
    }),

    // Sign + BROADCAST a prepared DID profile update (the approved step). Invalidates identity + ledger.
    confirmDidProfileUpdate: build.mutation<{ spentCoinId: string }, { pendingId: string }>({
      query: (arg) => ({ action: ACTIONS.confirmDidProfileUpdate, ...arg }),
      invalidatesTags: ['Identity', 'Activity', 'Balances'],
    }),
  }),
  overrideExisting: false,
});

export const {
  useListDidsQuery,
  usePrepareDidCreateMutation,
  useConfirmDidCreateMutation,
  usePrepareDidTransferMutation,
  useConfirmDidTransferMutation,
  usePrepareDidProfileUpdateMutation,
  useConfirmDidProfileUpdateMutation,
} = identityApi;
