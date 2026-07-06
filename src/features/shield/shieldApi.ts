import { api } from '@/api/api';
import { ACTIONS } from '#shared/messages.mjs';
import type { LedgerEntry } from '@/lib/dig-ledger';

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
  }),
  overrideExisting: false,
});

export const { useGetShieldLedgerQuery } = shieldApi;
