import { api } from '@/api/api';
import { ACTIONS } from '@/lib/messages';
import type { LedgerEntry } from '@/lib/dig-ledger';
import { normalizeVerifyLedger, type VerifyLedger } from '@/lib/verify-ledger';

/** `getShieldLedger` — the active tab's capsule + grouped per-resource proof ledger. */
export interface ShieldLedger {
  capsule: { storeId: string; rootHash: string } | null;
  verification: { state: string } | null;
  group: {
    passed: LedgerEntry[];
    failed: LedgerEntry[];
    passedCount: number;
    failedCount: number;
    total: number;
    allPassed: boolean;
    empty: boolean;
  };
  entries: LedgerEntry[];
}

export const shieldApi = api.injectEndpoints({
  endpoints: (build) => ({
    getShieldLedger: build.query<ShieldLedger, void>({
      query: () => ({ action: ACTIONS.getShieldLedger }),
      providesTags: ['Shield'],
    }),
    // The AUTHORITATIVE server-side verification ledger from the local dig-node (#307). Normalized
    // + aggregate-recomputed at the wire boundary so the badge/modal never trust a malformed
    // response. Fails (isError) when no local node is reachable or no capsule is active — the modal
    // renders those honestly. `refetchOnMountOrArgChange` (opt-in at the call site) keeps it fresh.
    getVerifyLedger: build.query<VerifyLedger, void>({
      query: () => ({ action: ACTIONS.getVerifyLedger }),
      transformResponse: (raw: unknown) => normalizeVerifyLedger(raw),
      providesTags: ['Shield'],
    }),
  }),
  overrideExisting: false,
});

export const { useGetShieldLedgerQuery, useGetVerifyLedgerQuery } = shieldApi;
