import { api, type ThunkExtra } from '@/api/api';
import { assetDescriptors, type AssetDescriptor } from '@/lib/wallet-assets';
import { pickBalance, formatBaseUnits, activityViewModel, type ActivityItem } from '@/lib/wallet-view';
import { DIG_ASSET_ID } from '@/lib/links';
import { storageGet } from '@/lib/messaging';
import type { Connection } from '@/features/wallet/transport';

/** One asset row: its descriptor + the raw balance (base units) + a display label. */
export interface AssetBalance {
  descriptor: AssetDescriptor;
  /** Balance in base units, or null when unavailable (never a false 0). */
  balance: number | null;
  /** Display label (crypto amount, trailing zeros trimmed) or an em dash. */
  label: string;
}

const WATCHED_KEY = 'wallet.watchedCats';

function extra(apiArg: { extra: unknown }): ThunkExtra {
  return apiArg.extra as ThunkExtra;
}

/**
 * Wallet endpoints — Phase 0 brokers reads/writes to Sage via the page-resident WalletConnect
 * transport (the extension holds no keys). Each uses `queryFn` so the injected transport is the
 * seam; tags drive cross-view cache convergence.
 */
export const walletApi = api.injectEndpoints({
  endpoints: (build) => ({
    getConnection: build.query<Connection, void>({
      async queryFn(_arg, apiArg) {
        try {
          const conn = await extra(apiArg).transport.getConnection();
          return { data: conn };
        } catch (e) {
          return { error: { code: 'CONNECTION', message: e instanceof Error ? e.message : String(e) } };
        }
      },
      providesTags: ['Connection'],
    }),

    getBalances: build.query<AssetBalance[], void>({
      async queryFn(_arg, apiArg) {
        const { transport } = extra(apiArg);
        try {
          if (!(await transport.isConnected())) return { data: [] };
          const stored = await storageGet<{ [WATCHED_KEY]: unknown }>(WATCHED_KEY);
          const descriptors = assetDescriptors(stored[WATCHED_KEY]);
          const rows: AssetBalance[] = [];
          for (const d of descriptors) {
            let balance: number | null = null;
            try {
              const resp = await transport.request('chip0002_getAssetBalance', {
                type: d.type,
                assetId: d.assetId,
              });
              balance = pickBalance(resp);
            } catch {
              balance = null;
            }
            rows.push({ descriptor: d, balance, label: formatBaseUnits(balance, d.decimals) });
          }
          return { data: rows };
        } catch (e) {
          return { error: { code: 'BALANCES', message: e instanceof Error ? e.message : String(e) } };
        }
      },
      providesTags: ['Balances'],
    }),

    getActivity: build.query<ActivityItem[], void>({
      async queryFn(_arg, apiArg) {
        const { transport } = extra(apiArg);
        try {
          if (!(await transport.isConnected())) return { data: [] };
          const raw = await transport.request('chia_getTransactions', {});
          return { data: activityViewModel(raw, { digAssetId: DIG_ASSET_ID }) };
        } catch (e) {
          return { error: { code: 'ACTIVITY', message: e instanceof Error ? e.message : String(e) } };
        }
      },
      providesTags: ['Activity'],
    }),

    disconnect: build.mutation<{ ok: true }, void>({
      async queryFn(_arg, apiArg) {
        try {
          await extra(apiArg).transport.disconnect();
          return { data: { ok: true } };
        } catch (e) {
          return { error: { code: 'DISCONNECT', message: e instanceof Error ? e.message : String(e) } };
        }
      },
      invalidatesTags: ['Connection', 'Balances', 'Activity', 'Offers'],
    }),

    sendAsset: build.mutation<
      unknown,
      { method: string; params: Record<string, unknown> }
    >({
      async queryFn({ method, params }, apiArg) {
        try {
          const data = await extra(apiArg).transport.request(method, params);
          return { data };
        } catch (e) {
          return { error: { code: 'SEND', message: e instanceof Error ? e.message : String(e) } };
        }
      },
      invalidatesTags: ['Balances', 'Activity'],
    }),

    offerAction: build.mutation<
      unknown,
      { method: string; params: Record<string, unknown> }
    >({
      async queryFn({ method, params }, apiArg) {
        try {
          const data = await extra(apiArg).transport.request(method, params);
          return { data };
        } catch (e) {
          return { error: { code: 'OFFER', message: e instanceof Error ? e.message : String(e) } };
        }
      },
      invalidatesTags: ['Balances', 'Activity', 'Offers'],
    }),
  }),
  overrideExisting: false,
});

export const {
  useGetConnectionQuery,
  useGetBalancesQuery,
  useGetActivityQuery,
  useDisconnectMutation,
  useSendAssetMutation,
  useOfferActionMutation,
} = walletApi;
