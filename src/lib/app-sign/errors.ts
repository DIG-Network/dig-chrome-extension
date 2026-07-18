/**
 * The APP-SIGN error taxonomy (dig-app `SPEC.md §5.6.7`) — the stable symbolic codes dig-app
 * returns as JSON-RPC errors on the paired `ws://127.0.0.1:9779` identity channel, plus the
 * transport-level codes the extension itself raises before/around a request.
 *
 * The extension keys its UX off these codes, NEVER off human prose (§6.2 machine-consumable
 * contract). The server codes below are the byte-identical cross-repo contract — they MUST match
 * dig-app's exactly; the transport codes are extension-local (the app-not-running / socket-down /
 * timeout conditions that never reach dig-app).
 *
 * Pure (no chrome.* / DOM) so the SW bundle and tests import it directly.
 */

/** The server-returned codes from dig-app SPEC §5.6.7 (byte-identical cross-repo contract). */
export const APP_SIGN_SERVER_CODES = [
  'AUTH_REQUIRED', // no valid pairing for this frame (unpaired / revoked)
  'AUTH_BAD_MAC', // pairing-token MAC verification failed
  'AUTH_REPLAY', // frame nonce not strictly greater than the last accepted
  'PAIR_DENIED', // user denied the pairing confirm
  'PAIR_TIMEOUT', // user did not answer the pairing confirm
  'CONNECT_REQUIRED', // the origin is not whitelisted for the active profile
  'CONNECT_DENIED', // user denied the connect modal
  'CONNECT_TIMEOUT', // user did not answer the connect modal
  'SIGN_DENIED', // user denied the sign confirm
  'SIGN_TIMEOUT', // user did not answer the sign confirm
  'SIGN_UNKNOWN_TYPE', // payload_type not on the decoder allowlist (blind-sign refused)
  'SIGN_BAD_PAYLOAD', // known type, but the payload did not decode for display
  'SIGN_NO_CONFIRMER', // no desktop session — native confirm unavailable (headless fail-closed)
  'LOCKED', // the active profile could not be unlocked
] as const;

/** Transport-level codes the EXTENSION raises (never returned by dig-app). */
export const APP_SIGN_TRANSPORT_CODES = [
  'APP_NOT_RUNNING', // connection to 127.0.0.1:9779 refused — dig-app is not running
  'NOT_PAIRED', // no stored pairing record — must run pair.begin first
  'TRANSPORT_TIMEOUT', // no response frame arrived within the request timeout
  'TRANSPORT_CLOSED', // the socket closed with the request still in flight
  'BAD_RESPONSE', // dig-app returned a malformed / unparseable frame
] as const;

/** Every APP-SIGN code the extension can surface (server ∪ transport). */
export type AppSignCode = (typeof APP_SIGN_SERVER_CODES)[number] | (typeof APP_SIGN_TRANSPORT_CODES)[number];

const SERVER_CODE_SET: ReadonlySet<string> = new Set(APP_SIGN_SERVER_CODES);

/** True when `code` is one of dig-app's server-returned codes (as opposed to a transport code). */
export function isServerCode(code: string): code is (typeof APP_SIGN_SERVER_CODES)[number] {
  return SERVER_CODE_SET.has(code);
}

/**
 * An APP-SIGN failure carrying a stable {@link AppSignCode}. Thrown by the relay/controller so a
 * caller (and the provider that surfaces it to the dapp) branches on `code`, not on the message.
 */
export class AppSignError extends Error {
  constructor(
    readonly code: AppSignCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'AppSignError';
  }
}
