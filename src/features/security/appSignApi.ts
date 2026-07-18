import { api } from '@/api/api';
import { ACTIONS } from '@/lib/messages';

/**
 * The APP-SIGN pairing surface (SIGN-4, #950; dig-app `SPEC.md §5.6`). Reads the dig-app pairing +
 * identity-channel state and drives pair/unpair over the SW's {@link ACTIONS.appSignStatus} /
 * {@link ACTIONS.appSignPair} / {@link ACTIONS.appSignUnpair} dispatchers.
 *
 * This is the IDENTITY channel to the dig-app tray process — distinct from the extension↔dig-node
 * content channel. The extension is the trusted-once MEDIATOR: pairing is a one-time native confirm
 * dig-app raises; the user key never enters the extension (§5.6.1). No credential is handled here —
 * only the pairing lifecycle + a live channel-connection indicator.
 *
 * The SW returns `{ ok, data }` on success and `{ success:false, code, message }` on failure (the
 * §5.6.7 code the UI keys its messaging off), so mutations invalidate `AppSign` to re-read the live
 * paired state.
 */

/** The live APP-SIGN state the UI renders. */
export interface AppSignStatus {
  /** True once a pairing record is stored (dig-app approved a `pair.begin`). */
  paired: boolean;
  /** The identity-channel transport state; `connected` means dig-app is reachable on the loopback. */
  connState: 'connecting' | 'connected' | 'disconnected';
}

/** Normalize the SW `{ ok, data }` envelope to the live status, fail-safe to "not paired / down". */
function toStatus(raw: unknown): AppSignStatus {
  const data = (raw as { data?: Partial<AppSignStatus> } | undefined)?.data ?? {};
  const connState = data.connState === 'connected' || data.connState === 'connecting' ? data.connState : 'disconnected';
  return { paired: data.paired === true, connState };
}

export const appSignApi = api.injectEndpoints({
  endpoints: (build) => ({
    getAppSignStatus: build.query<AppSignStatus, void>({
      query: () => ({ action: ACTIONS.appSignStatus }),
      transformResponse: toStatus,
      providesTags: ['AppSign'],
    }),

    // Trigger dig-app's native pairing confirm + store the channel token. A user deny / a stopped
    // dig-app surfaces as the §5.6.7 `PAIR_DENIED` / `APP_NOT_RUNNING` error code.
    pairAppSign: build.mutation<void, void>({
      query: () => ({ action: ACTIONS.appSignPair }),
      invalidatesTags: ['AppSign'],
    }),

    // Delete the local pairing record (the local half of unpair).
    unpairAppSign: build.mutation<void, void>({
      query: () => ({ action: ACTIONS.appSignUnpair }),
      invalidatesTags: ['AppSign'],
    }),
  }),
  overrideExisting: false,
});

export const { useGetAppSignStatusQuery, usePairAppSignMutation, useUnpairAppSignMutation } = appSignApi;
