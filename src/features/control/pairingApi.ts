import { api } from '@/api/api';
import { ACTIONS } from '@/lib/messages';
import type { PairingState } from '@/lib/dig-pairing';

/**
 * Control-token pairing (#280): the pairing state query + the start/cancel/unpair mutations. The
 * SW owns the state machine + poll loop + stored token; `controlPanelSync` invalidates the
 * `Pairing` tag on the SW's `pairingStateChanged` broadcast so the panel reflects approval live.
 * The token value itself is NEVER returned to the UI (only the phase).
 */
export const pairingApi = api.injectEndpoints({
  endpoints: (build) => ({
    getPairingState: build.query<PairingState, void>({
      query: () => ({ action: ACTIONS.pairingState }),
      providesTags: ['Pairing'],
    }),
    startPairing: build.mutation<PairingState, void>({
      query: () => ({ action: ACTIONS.pairingStart }),
      invalidatesTags: ['Pairing'],
    }),
    cancelPairing: build.mutation<PairingState, void>({
      query: () => ({ action: ACTIONS.pairingCancel }),
      invalidatesTags: ['Pairing'],
    }),
    unpair: build.mutation<PairingState, void>({
      query: () => ({ action: ACTIONS.pairingUnpair }),
      // Unpairing invalidates every token-gated surface (they revert to "pair to manage").
      invalidatesTags: ['Pairing', 'Upstream', 'HostedStores', 'Sync', 'Peers'],
    }),
  }),
  overrideExisting: false,
});

export const {
  useGetPairingStateQuery,
  useStartPairingMutation,
  useCancelPairingMutation,
  useUnpairMutation,
} = pairingApi;
