import { api } from '@/api/api';
import { ACTIONS } from '@/lib/messages';
import type { LockState } from '@/features/wallet/walletSlice';
import type { DappSpendSummary } from '@/offscreen/dappSign';
import type { OriginRisk } from '@/lib/phishing';

/**
 * dApp approval-window endpoints (#56 §5.5) — the window ↔ SW channel over the `chromeBaseQuery`
 * seam. The list query is polled so a newly-summoned request (and a lock-state change after an
 * inline unlock) appears; the resolve mutation returns the user's decision (approve → the offscreen
 * vault signs; reject → the dApp gets an error) and invalidates the queue so it refreshes.
 */

/** The decoded summary for a message-signing request (no key needed — the message IS the fact). */
export interface DappMessageSummary {
  message: string;
  publicKey: string | null;
}

/** One pending dApp signing request, as the approval window renders it. */
export interface DappApprovalRequest {
  id: string;
  origin: string;
  method: string;
  kind: 'signCoinSpends' | 'signMessage';
  /** The tamper-resistant summary decoded FROM THE BUILT SPEND, or `null` when not yet decodable. */
  summary: DappSpendSummary | DappMessageSummary | null;
  /** The wallet is locked; the summary can't be decoded until the user unlocks. */
  needsUnlock: boolean;
  /** The request could not be safely decoded (malformed); only Reject is offered. */
  decodeError: boolean;
  /** Phishing/lookalike verdict for the requesting origin (#67 P0-2); drives the interstitial. */
  originRisk?: OriginRisk;
  createdAt: number;
}

/** The approval queue snapshot + the current lock state. */
export interface DappApprovalQueue {
  requests: DappApprovalRequest[];
  lockState: LockState;
  summoned: boolean;
}

export const approvalApi = api.injectEndpoints({
  endpoints: (build) => ({
    getDappApprovalQueue: build.query<DappApprovalQueue, void>({
      query: () => ({ action: ACTIONS.dappApprovalList }),
      providesTags: ['DappApprovals', 'LockState'],
    }),
    resolveDappApproval: build.mutation<{ success: boolean; remaining: number; code?: string }, { id: string; approved: boolean }>({
      query: (arg) => ({ action: ACTIONS.dappApprovalResolve, ...arg }),
      invalidatesTags: ['DappApprovals'],
    }),
  }),
  overrideExisting: false,
});

export const { useGetDappApprovalQueueQuery, useResolveDappApprovalMutation } = approvalApi;
