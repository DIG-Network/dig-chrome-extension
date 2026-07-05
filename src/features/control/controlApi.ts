import { api } from '@/api/api';
import { ACTIONS } from '#shared/messages.mjs';

/** `getControlStatus` — the raw node-detection + best-effort control.status payload. */
export interface ControlStatusResponse {
  mode: 'manage' | 'install';
  localNode: boolean;
  base: string | null;
  controlEndpoint: string | null;
  readFallback: string;
  status: Record<string, unknown> | null;
  authRequired: boolean;
  controlMethods: string[];
}

export const controlApi = api.injectEndpoints({
  endpoints: (build) => ({
    getControlStatus: build.query<ControlStatusResponse, void>({
      query: () => ({ action: ACTIONS.getControlStatus }),
      providesTags: ['Control'],
    }),
  }),
  overrideExisting: false,
});

export const { useGetControlStatusQuery } = controlApi;
