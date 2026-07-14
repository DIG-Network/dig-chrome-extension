import { api } from '@/api/api';
import { ACTIONS } from '@/lib/messages';
import { normalizeUpdaterStatus, type UpdaterStatusResponse } from '@/lib/updater-status';

/**
 * The fullscreen Updates-tab data surface (#504-K/#516): a THIN reader/driver over the dig-node
 * `control.updater.*` proxy (dig-node #515), which itself forwards the DIG auto-update beacon's
 * (`dig-updater`) status/CLI output verbatim (dig-updater SPEC §13.2/§13.3). This slice never
 * re-implements any beacon logic — it only reads the status mirror and drives the three mutating
 * commands the operator would otherwise run from a terminal.
 *
 * Every endpoint routes through the SAME token-gated `control.*` transport the other paired
 * management sections use (`ACTIONS.controlAuthed`, #281) — the beacon proxy inherits the existing
 * control-token auth, so there is no separate pairing flow to build (dig-node #515 design note).
 */
export const updaterApi = api.injectEndpoints({
  endpoints: (build) => ({
    // The beacon's status mirror. `{ installed: false }` (never installed) is a NORMAL result, not
    // an error — `normalizeUpdaterStatus` keeps that shape all the way to the view.
    getUpdaterStatus: build.query<UpdaterStatusResponse, void>({
      query: () => ({ action: ACTIONS.controlAuthed, method: 'control.updater.status' }),
      transformResponse: (raw: unknown) => normalizeUpdaterStatus(raw),
      providesTags: ['Updater'],
    }),

    // Suspend auto-updates. `until` is an optional unix-seconds snooze deadline; omitted pauses
    // indefinitely until an explicit resume (dig-updater SPEC §13.1).
    pauseUpdater: build.mutation<unknown, { until?: number } | void>({
      query: (params) => ({ action: ACTIONS.controlAuthed, method: 'control.updater.pause', params: params ?? {} }),
      invalidatesTags: ['Updater'],
    }),

    resumeUpdater: build.mutation<unknown, void>({
      query: () => ({ action: ACTIONS.controlAuthed, method: 'control.updater.resume' }),
      invalidatesTags: ['Updater'],
    }),

    // An on-demand full pass, identical gating to the beacon's daily schedule. SYNCHRONOUS on the
    // node side — it can take a while (fetch + verify + install behind the health gate) — the
    // caller's `isLoading` is the UI's only progress signal (dig-node #515 design note).
    checkNowUpdater: build.mutation<unknown, void>({
      query: () => ({ action: ACTIONS.controlAuthed, method: 'control.updater.checkNow' }),
      invalidatesTags: ['Updater'],
    }),
  }),
  overrideExisting: false,
});

export const {
  useGetUpdaterStatusQuery,
  usePauseUpdaterMutation,
  useResumeUpdaterMutation,
  useCheckNowUpdaterMutation,
} = updaterApi;
