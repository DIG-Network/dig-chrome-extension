/**
 * dig-node unlock-authentication model (SPEC §18.24, #431/#432) — the PURE, DOM-free, chrome-free
 * client model behind the fullscreen Security tab + the per-transaction sign-unlock prompt. The
 * dig-node is the LOCAL auth authority + key custodian; the extension is a FRONTEND that reads +
 * drives the node's `auth.*` surface. This module carries the shapes, defends every field of a
 * node-supplied blob (never trust the wire), and derives the mode-aware UI/gate logic.
 *
 * The security posture is SAFE BY DEFAULT (§18.24): the decrypted key never persists in the node
 * beyond a single signature. The default mode `per_transaction` grants a READ-ONLY session on unlock
 * and requires a FRESH `auth.sign_unlock` before EVERY signature; `session_unlock_all` is the OFF-by-
 * default convenience opt-out where one unlock covers the session. The active method is password
 * (default) plus an optional node-level second factor: TOTP (fully supported) or passkey (node verify
 * is DEFERRED — the active method can never become `passkey` yet).
 */

/** The unlock mode — the only policy knob (§18.24). */
export type UnlockMode = 'per_transaction' | 'session_unlock_all';
/** The active unlock authentication method (§18.24). Passkey is present-but-node-deferred. */
export type AuthMethod = 'password' | 'totp' | 'passkey';
/** The node-reported session state (§18.24). */
export type AuthSessionState = 'locked' | 'read_only';

/** The auth status the node reports (`auth.status`), in the extension's camelCase model. */
export interface AuthStatus {
  /** The active unlock mode. */
  mode: UnlockMode;
  /** The active authentication method. */
  method: AuthMethod;
  /** The current session state. */
  state: AuthSessionState;
  /** Whether a one-shot per-transaction sign grant is armed right now. */
  signArmed: boolean;
  /** Whether the node custodies any wallet (so a caller knows unlock is possible). */
  hasWallet: boolean;
}

/** The one-time TOTP enrollment result (`auth.enroll_totp`) — the secret/URI to provision an authenticator. */
export interface TotpEnrollment {
  /** The base32-encoded shared secret (manual-entry key). */
  secretBase32: string;
  /** The `otpauth://totp/...` provisioning URI (rendered as a QR). */
  otpauthUri: string;
}

/** A presented unlock credential: the target wallet's password + (when active) the node-level TOTP code. */
export interface AuthCredential {
  /** The target wallet's password (its seed's at-rest KDF root). Always required. */
  password: string;
  /** The current node-level TOTP code — required when the active method is `totp`. */
  totpCode?: string;
}

/** The SECURE default posture (§18.24): locked, per-transaction, password-only, nothing armed. */
export const DEFAULT_AUTH_STATUS: AuthStatus = {
  mode: 'per_transaction',
  method: 'password',
  state: 'locked',
  signArmed: false,
  hasWallet: false,
};

/** Node WebAuthn verification is DEFERRED (§18.24) — passkey can be shown but never selected as active. */
export const PASSKEY_AVAILABLE = false as const;

const MODES: readonly UnlockMode[] = ['per_transaction', 'session_unlock_all'];
const METHODS: readonly AuthMethod[] = ['password', 'totp', 'passkey'];

/** Type guard: is `v` a known unlock mode? */
export function isUnlockMode(v: unknown): v is UnlockMode {
  return typeof v === 'string' && (MODES as readonly string[]).includes(v);
}

/** Type guard: is `v` a known auth method? */
export function isAuthMethod(v: unknown): v is AuthMethod {
  return typeof v === 'string' && (METHODS as readonly string[]).includes(v);
}

/**
 * Normalize the node's `auth.status` result into a trusted {@link AuthStatus}. Every field defaults to
 * the SECURE posture ({@link DEFAULT_AUTH_STATUS}) when missing or malformed — a garbage blob can never
 * present as unlocked or as a weaker mode/method than the node actually reports.
 */
export function normalizeAuthStatus(raw: unknown): AuthStatus {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    mode: isUnlockMode(r.mode) ? r.mode : DEFAULT_AUTH_STATUS.mode,
    method: isAuthMethod(r.method) ? r.method : DEFAULT_AUTH_STATUS.method,
    state: r.state === 'read_only' ? 'read_only' : 'locked',
    signArmed: r.sign_armed === true,
    hasWallet: r.has_wallet === true,
  };
}

/** Normalize the one-time TOTP enrollment blob, or `null` when either field is missing/empty. */
export function normalizeTotpEnrollment(raw: unknown): TotpEnrollment | null {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const secretBase32 = typeof r.secret_base32 === 'string' ? r.secret_base32 : '';
  const otpauthUri = typeof r.otpauth_uri === 'string' ? r.otpauth_uri : '';
  if (!secretBase32 || !otpauthUri) return null;
  return { secretBase32, otpauthUri };
}

/** The UI's session view: locked · read-only (per-tx, each sign re-prompts) · unlocked-for-session. */
export type UnlockView = 'locked' | 'read-only' | 'unlocked-session';

/**
 * Map an {@link AuthStatus} to its {@link UnlockView}. A locked session is `locked`; a read-only session
 * is `read-only` in per-transaction mode (signing still needs a fresh unlock) and `unlocked-session` in
 * session-unlock-all mode (the held signer covers the session).
 */
export function unlockView(s: AuthStatus): UnlockView {
  if (s.state === 'locked') return 'locked';
  return s.mode === 'session_unlock_all' ? 'unlocked-session' : 'read-only';
}

/**
 * Whether a signing operation must prompt for a fresh unlock BEFORE it proceeds. In `per_transaction`
 * (the secure default) EVERY signature re-prompts. In `session_unlock_all` a prompt is needed only when
 * the session is not yet unlocked (`state !== 'read_only'`); once unlocked, the session covers signing.
 */
export function signPromptNeeded(s: AuthStatus): boolean {
  if (s.mode === 'per_transaction') return true;
  return s.state !== 'read_only';
}

/**
 * Whether switching the unlock mode to `target` requires the current factor. Switching INTO
 * `session_unlock_all` WEAKENS the posture, so the node re-verifies the current factor (§18.24);
 * tightening back to `per_transaction` needs none.
 */
export function modeChangeNeedsCredential(target: UnlockMode): boolean {
  return target === 'session_unlock_all';
}

/** Whether a credential for `s` must include a live TOTP code (the active method is `totp`). */
export function credentialRequiresTotp(s: AuthStatus): boolean {
  return s.method === 'totp';
}

/**
 * Whether `v` is a well-formed RFC-6238 TOTP code — EXACTLY six decimal digits. The node is the
 * authority (it validates skew + one-time-use + the shared secret); this is only the client-side
 * shape gate that keeps the submit button honest so a half-typed code is never sent.
 */
export function isTotpCode(v: string): boolean {
  return /^\d{6}$/.test(v);
}

/**
 * Map a {@link AuthCredential} to the node's snake_case request params (`password` + optional
 * `totp_code`). A blank/whitespace-only code is omitted so the node validates it as absent.
 */
export function credentialToParams(c: AuthCredential): { password: string; totp_code?: string } {
  const code = c.totpCode?.trim();
  return code ? { password: c.password, totp_code: code } : { password: c.password };
}
