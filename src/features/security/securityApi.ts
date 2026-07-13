import { api } from '@/api/api';
import { ACTIONS } from '@/lib/messages';
import {
  normalizeAuthStatus,
  normalizeTotpEnrollment,
  credentialToParams,
  type AuthStatus,
  type AuthCredential,
  type TotpEnrollment,
  type UnlockMode,
  type AuthMethod,
} from '@/lib/node-auth';

/**
 * The Security-tab data surface (SPEC §18.24, #431/#432/#433): the node-managed unlock-auth
 * `auth.*` methods, driven over the SW's {@link ACTIONS.authRpc} dispatcher (WS-first, HTTP
 * fallback, paired-token gated §7.12), plus the {@link ACTIONS.getSignAuthority} flag (#374). Every
 * status-returning method is normalized through {@link normalizeAuthStatus} so a garbage/absent
 * blob can never present as a weaker posture than the node reports (fail-secure). Endpoints inject
 * into the single `api` slice; mutations invalidate `Auth` so the tab + the per-transaction sign
 * gate always read the LIVE lock/session state.
 *
 * The decrypted key is NEVER handled here — the node is the custodian; the extension only presents
 * the credential (the target wallet's password + an optional node-level TOTP code) and reads the
 * resulting session/lock posture. Passkey enrollment is intentionally absent: node WebAuthn verify
 * is deferred (`PASSKEY_AVAILABLE=false`), so the UI shows a disabled "coming soon" option rather
 * than wiring a method the node fails closed on.
 */
export const securityApi = api.injectEndpoints({
  endpoints: (build) => ({
    // The live auth posture (mode/method/session-state/sign-armed/has-wallet). Read-only; open on
    // the /ws read plane. Normalized fail-secure.
    getAuthStatus: build.query<AuthStatus, void>({
      query: () => ({ action: ACTIONS.authRpc, method: 'auth.status' }),
      transformResponse: (raw: unknown) => normalizeAuthStatus(raw),
      providesTags: ['Auth'],
    }),

    // Whether the dig-node is the signing authority on this caller (thin-client cutover flag #374).
    // The per-transaction sign gate reads this: true ⇒ node custody+signing ⇒ arm `auth.sign_unlock`
    // before a spend; false (default) ⇒ local-vault custody, no node auth gate (the gate is inert).
    getSignAuthority: build.query<{ nodeIsSigner: boolean }, void>({
      query: () => ({ action: ACTIONS.getSignAuthority }),
    }),

    // Switch the unlock mode. Switching INTO `session_unlock_all` WEAKENS the posture, so the node
    // re-verifies the current factor — the caller supplies the credential in that case (SPEC §18.24).
    setAuthMode: build.mutation<AuthStatus, { mode: UnlockMode; credential?: AuthCredential }>({
      query: ({ mode, credential }) => ({
        action: ACTIONS.authRpc,
        method: 'auth.set_mode',
        params: { mode, ...(credential ? credentialToParams(credential) : {}) },
      }),
      transformResponse: (raw: unknown) => normalizeAuthStatus(raw),
      invalidatesTags: ['Auth'],
    }),

    // Switch the active method. Enrolling/replacing re-verifies the CURRENT factor (SPEC §18.24);
    // `password` resets to password-only. TOTP is enrolled via `enrollTotp` (needs the one-time
    // secret round-trip) — this method is used to reset back to password.
    setAuthMethod: build.mutation<AuthStatus, { method: AuthMethod; credential: AuthCredential }>({
      query: ({ method, credential }) => ({
        action: ACTIONS.authRpc,
        method: 'auth.set_method',
        params: { method, ...credentialToParams(credential) },
      }),
      transformResponse: (raw: unknown) => normalizeAuthStatus(raw),
      invalidatesTags: ['Auth'],
    }),

    // Enroll a fresh node-level TOTP secret (re-verifies the current factor). Returns the base32
    // secret + `otpauth://` URI EXACTLY ONCE (to provision the authenticator) — never returned again.
    enrollTotp: build.mutation<TotpEnrollment | null, AuthCredential>({
      query: (credential) => ({
        action: ACTIONS.authRpc,
        method: 'auth.enroll_totp',
        params: credentialToParams(credential),
      }),
      transformResponse: (raw: unknown) => normalizeTotpEnrollment(raw),
      invalidatesTags: ['Auth'],
    }),

    // Authenticate a READ-ONLY session (per_transaction) or build+hold the session signer
    // (session_unlock_all). Never returns a key. A wrong/expired/replayed credential is a node 401.
    unlock: build.mutation<AuthStatus, AuthCredential>({
      query: (credential) => ({
        action: ACTIONS.authRpc,
        method: 'auth.unlock',
        params: credentialToParams(credential),
      }),
      transformResponse: (raw: unknown) => normalizeAuthStatus(raw),
      invalidatesTags: ['Auth'],
    }),

    // Arm EXACTLY ONE signature with a FRESH credential (the per-transaction unlock). The node
    // decrypts, signs one op, and drops the signer — the key never persists (SPEC §18.24).
    signUnlock: build.mutation<AuthStatus, AuthCredential>({
      query: (credential) => ({
        action: ACTIONS.authRpc,
        method: 'auth.sign_unlock',
        params: credentialToParams(credential),
      }),
      transformResponse: (raw: unknown) => normalizeAuthStatus(raw),
      invalidatesTags: ['Auth'],
    }),

    // Clear the read-only session, drop the held session signer AND any armed one-shot grant.
    lock: build.mutation<AuthStatus, void>({
      query: () => ({ action: ACTIONS.authRpc, method: 'auth.lock', params: {} }),
      transformResponse: (raw: unknown) => normalizeAuthStatus(raw),
      invalidatesTags: ['Auth'],
    }),
  }),
  overrideExisting: false,
});

export const {
  useGetAuthStatusQuery,
  useGetSignAuthorityQuery,
  useSetAuthModeMutation,
  useSetAuthMethodMutation,
  useEnrollTotpMutation,
  useUnlockMutation,
  useSignUnlockMutation,
  useLockMutation,
} = securityApi;
