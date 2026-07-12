import { api } from '@/api/api';
import { ACTIONS } from '@/lib/messages';

/** Result of a one-tap creator tip. Success carries a `txId`; a failure carries a catalogued `code`
 *  (`TIP_SKIPPED` with the node's skip reason — e.g. the #428 pre-broadcaster `wallet-unavailable` —
 *  or a transport code) + a message. */
export interface TipResult {
  success?: boolean;
  txId?: string;
  code?: string;
  message?: string;
}

/**
 * Creator-tip endpoint (#379/#380). The one-tap tip routes to the SW `tipCreator` action, which drives
 * the dig-node tipping subsystem's `tip.manual` (#377, SPEC §18.23) over the /ws transport. A real
 * broadcast returns success + a txId; a `skipped` outcome (incl. #428's pre-broadcaster state) is
 * Query error the widget renders honestly. On success it invalidates the wallet balance + activity
 * caches AND the Tip tab ledger (the tip spent $DIG + added a ledger entry), so those views refresh
 * once the node executes it.
 */
export const tipApi = api.injectEndpoints({
  endpoints: (build) => ({
    tipCreator: build.mutation<TipResult, { storeId: string; amountDig: string }>({
      query: (arg) => ({ action: ACTIONS.tipCreator, ...arg }),
      invalidatesTags: ['Balances', 'Activity', 'TipLedger'],
    }),
  }),
  overrideExisting: false,
});

export const { useTipCreatorMutation } = tipApi;
