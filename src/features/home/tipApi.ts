import { api } from '@/api/api';
import { ACTIONS } from '@/lib/messages';

/** Result of a one-tap creator tip. Success carries a `txId`; a failure carries a catalogued `code`
 *  (today always `TIP_SUBSYSTEM_UNAVAILABLE` — the dig-node tipping subsystem #377 is not built). */
export interface TipResult {
  success?: boolean;
  txId?: string;
  code?: string;
  message?: string;
}

/**
 * Creator-tip endpoint (#379). The one-tap tip routes to the SW `tipCreator` action, which delegates
 * to the dig-node tipping subsystem (#377/#369 WS). That subsystem is NOT built yet, so the SW handler
 * is a flagged stub returning `TIP_SUBSYSTEM_UNAVAILABLE` — surfaced by `chromeBaseQuery` as an RTK
 * Query error the widget renders honestly. On success it invalidates the wallet balance + activity
 * caches (the tip spent $DIG), so those views refresh once the node executes it.
 */
export const tipApi = api.injectEndpoints({
  endpoints: (build) => ({
    tipCreator: build.mutation<TipResult, { storeId: string; amountDig: string }>({
      query: (arg) => ({ action: ACTIONS.tipCreator, ...arg }),
      invalidatesTags: ['Balances', 'Activity'],
    }),
  }),
  overrideExisting: false,
});

export const { useTipCreatorMutation } = tipApi;
