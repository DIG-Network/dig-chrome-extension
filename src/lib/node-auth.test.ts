import { describe, it, expect } from 'vitest';
import {
  DEFAULT_AUTH_STATUS,
  PASSKEY_AVAILABLE,
  normalizeAuthStatus,
  normalizeTotpEnrollment,
  unlockView,
  signPromptNeeded,
  modeChangeNeedsCredential,
  credentialRequiresTotp,
  credentialToParams,
  isAuthMethod,
  isUnlockMode,
  isTotpCode,
} from './node-auth';

/**
 * Pure client model for the dig-node unlock-auth surface (SPEC §18.24). Mirrors the node's
 * `auth.*` wire contract; defends every field of a node-supplied blob (never trust the wire);
 * derives the mode-aware UI/gate logic. No DOM / chrome.* — fully unit-tested here.
 */

describe('normalizeAuthStatus', () => {
  it('reads the snake_case wire shape into the camelCase model', () => {
    const s = normalizeAuthStatus({
      mode: 'session_unlock_all',
      method: 'totp',
      state: 'read_only',
      sign_armed: true,
      has_wallet: true,
    });
    expect(s).toEqual({
      mode: 'session_unlock_all',
      method: 'totp',
      state: 'read_only',
      signArmed: true,
      hasWallet: true,
    });
  });

  it('falls back to the SECURE defaults on missing/garbage input', () => {
    expect(normalizeAuthStatus(null)).toEqual(DEFAULT_AUTH_STATUS);
    expect(normalizeAuthStatus({})).toEqual(DEFAULT_AUTH_STATUS);
    expect(normalizeAuthStatus({ mode: 'nope', method: 42, state: {} })).toEqual(DEFAULT_AUTH_STATUS);
    // The secure default is the SAFE posture: locked, per-transaction, password, nothing armed.
    expect(DEFAULT_AUTH_STATUS).toEqual({
      mode: 'per_transaction',
      method: 'password',
      state: 'locked',
      signArmed: false,
      hasWallet: false,
    });
  });
});

describe('normalizeTotpEnrollment', () => {
  it('reads the one-time secret/uri wire shape', () => {
    expect(
      normalizeTotpEnrollment({ secret_base32: 'ABCD2345', otpauth_uri: 'otpauth://totp/DIG?x=1' }),
    ).toEqual({ secretBase32: 'ABCD2345', otpauthUri: 'otpauth://totp/DIG?x=1' });
  });
  it('returns null when the enrollment blob is malformed', () => {
    expect(normalizeTotpEnrollment(null)).toBeNull();
    expect(normalizeTotpEnrollment({ secret_base32: '' })).toBeNull();
    expect(normalizeTotpEnrollment({ otpauth_uri: 'x' })).toBeNull();
  });
});

describe('unlockView', () => {
  it('is locked when the session is locked', () => {
    expect(unlockView(normalizeAuthStatus({ state: 'locked' }))).toBe('locked');
  });
  it('is read-only in per-transaction mode with a read-only session', () => {
    expect(unlockView(normalizeAuthStatus({ mode: 'per_transaction', state: 'read_only' }))).toBe('read-only');
  });
  it('is unlocked-session in session-unlock-all mode with a read-only session', () => {
    expect(unlockView(normalizeAuthStatus({ mode: 'session_unlock_all', state: 'read_only' }))).toBe(
      'unlocked-session',
    );
  });
});

describe('signPromptNeeded', () => {
  it('ALWAYS needs a fresh sign-unlock in per-transaction mode (the secure default)', () => {
    expect(signPromptNeeded(normalizeAuthStatus({ mode: 'per_transaction', state: 'locked' }))).toBe(true);
    // Even with a read-only session already granted, each signature re-prompts.
    expect(signPromptNeeded(normalizeAuthStatus({ mode: 'per_transaction', state: 'read_only' }))).toBe(true);
  });
  it('in session-unlock-all mode only needs a prompt when the session is not yet unlocked', () => {
    expect(signPromptNeeded(normalizeAuthStatus({ mode: 'session_unlock_all', state: 'locked' }))).toBe(true);
    expect(signPromptNeeded(normalizeAuthStatus({ mode: 'session_unlock_all', state: 'read_only' }))).toBe(false);
  });
});

describe('modeChangeNeedsCredential', () => {
  it('requires the current factor to WEAKEN into session-unlock-all', () => {
    expect(modeChangeNeedsCredential('session_unlock_all')).toBe(true);
  });
  it('needs no credential to TIGHTEN back to per-transaction', () => {
    expect(modeChangeNeedsCredential('per_transaction')).toBe(false);
  });
});

describe('credentialRequiresTotp', () => {
  it('requires a TOTP code only when the active method is totp', () => {
    expect(credentialRequiresTotp(normalizeAuthStatus({ method: 'totp' }))).toBe(true);
    expect(credentialRequiresTotp(normalizeAuthStatus({ method: 'password' }))).toBe(false);
    expect(credentialRequiresTotp(normalizeAuthStatus({ method: 'passkey' }))).toBe(false);
  });
});

describe('credentialToParams', () => {
  it('maps the credential to the snake_case wire params, omitting an empty code', () => {
    expect(credentialToParams({ password: 'pw' })).toEqual({ password: 'pw' });
    expect(credentialToParams({ password: 'pw', totpCode: '123456' })).toEqual({
      password: 'pw',
      totp_code: '123456',
    });
    expect(credentialToParams({ password: 'pw', totpCode: '   ' })).toEqual({ password: 'pw' });
  });
});

describe('guards + constants', () => {
  it('recognizes valid enum values', () => {
    expect(isAuthMethod('password')).toBe(true);
    expect(isAuthMethod('totp')).toBe(true);
    expect(isAuthMethod('passkey')).toBe(true);
    expect(isAuthMethod('nope')).toBe(false);
    expect(isUnlockMode('per_transaction')).toBe(true);
    expect(isUnlockMode('session_unlock_all')).toBe(true);
    expect(isUnlockMode('')).toBe(false);
  });
  it('passkey is not yet available (node WebAuthn verify is deferred, §18.24)', () => {
    expect(PASSKEY_AVAILABLE).toBe(false);
  });
  it('recognizes a well-formed 6-digit TOTP code, rejecting the malformed', () => {
    expect(isTotpCode('123456')).toBe(true);
    expect(isTotpCode('000000')).toBe(true);
    expect(isTotpCode('12345')).toBe(false); // too short
    expect(isTotpCode('1234567')).toBe(false); // too long
    expect(isTotpCode('12a456')).toBe(false); // non-digit
    expect(isTotpCode('')).toBe(false);
  });
});
