import { api } from '@/api/api';
import { ACTIONS } from '@/lib/messages';
import {
  normalizeTippingConfig,
  normalizeLedger,
  type TippingConfig,
  type TipLedgerEntry,
  type TipOutcome,
} from '@/lib/tipping';

/**
 * Tipping subsystem (#380, child of #377) — the extension-side view + management surface over the
 * dig-node tipping subsystem (SPEC §18.23). The node OWNS execution (keys, spend build/sign/broadcast);
 * this slice is a FRONTEND that reads the config + ledger and drives config/manual-tip mutations over
 * the token-gated `tip.*` WS surface, routed through the SW `tipRpc` action (WS-first, HTTP fallback).
 *
 * Cache tags: `TipConfig` (auto-tip policy) + `TipLedger` (the tip history). The SW's pushed
 * `{type:"tip"}` frame → `tipRecorded` broadcast → `controlPanelSync` invalidates `TipLedger`
 * (+ Balances/Activity) so the tab live-refreshes with no polling. Every raw node payload is
 * normalized by the pure `@/lib/tipping` model so the UI never trusts an unshaped blob.
 */
export const tippingApi = api.injectEndpoints({
  endpoints: (build) => ({
    /** The node tipping config (`tip.get_config`, OPEN read). */
    getTipConfig: build.query<TippingConfig, void>({
      query: () => ({ action: ACTIONS.tipRpc, method: 'tip.get_config' }),
      transformResponse: (raw: unknown) => normalizeTippingConfig(raw),
      providesTags: ['TipConfig'],
    }),

    /** The tip ledger, newest first (`tip.get_ledger`, OPEN read). Accepts an optional `sinceTs` filter. */
    getTipLedger: build.query<TipLedgerEntry[], { sinceTs?: number } | void>({
      query: (arg) => ({
        action: ACTIONS.tipRpc,
        method: 'tip.get_ledger',
        params: arg && arg.sinceTs ? { since_ts: arg.sinceTs } : {},
      }),
      // The node may return a bare array OR an `{ entries }`/`{ ledger }` envelope — accept all.
      transformResponse: (raw: unknown) => {
        const list =
          Array.isArray(raw)
            ? raw
            : raw && typeof raw === 'object'
              ? ((raw as { entries?: unknown; ledger?: unknown }).entries ??
                (raw as { ledger?: unknown }).ledger ??
                [])
              : [];
        return normalizeLedger(list);
      },
      providesTags: ['TipLedger'],
    }),

    /** Replace + persist the tipping config (`tip.set_config`, token-GATED). Returns the stored config. */
    setTipConfig: build.mutation<TippingConfig, TippingConfig>({
      query: (config) => ({ action: ACTIONS.tipRpc, method: 'tip.set_config', params: config }),
      transformResponse: (raw: unknown) => normalizeTippingConfig(raw),
      invalidatesTags: ['TipConfig'],
    }),

    /** One-tap manual tip to a store's owner (`tip.manual`, token-GATED). Returns a {@link TipOutcome}. */
    manualTip: build.mutation<TipOutcome, { storeId: string }>({
      query: ({ storeId }) => ({ action: ACTIONS.tipRpc, method: 'tip.manual', params: { store_id: storeId } }),
      invalidatesTags: ['TipLedger', 'Balances', 'Activity'],
    }),
  }),
  overrideExisting: false,
});

export const {
  useGetTipConfigQuery,
  useGetTipLedgerQuery,
  useSetTipConfigMutation,
  useManualTipMutation,
} = tippingApi;
