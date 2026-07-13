import { describe, it, expect, vi, afterEach } from 'vitest';
import { createStore } from '@/app/store';
import { securityApi } from '@/features/security/securityApi';

/** Capture the last `authRpc` envelope the slice sent over the SW seam. */
interface Sent {
  action?: string;
  method?: string;
  params?: Record<string, unknown>;
}

/**
 * Mock the SW seam. `reply(msg)` returns the canned node result for an envelope; `sink` records
 * every sent envelope so a test can assert the exact method + params the slice dispatched.
 */
function mockSw(reply: (msg: Sent) => unknown, sink?: Sent[]) {
  (chrome.runtime as unknown as { sendMessage: unknown }).sendMessage = vi.fn(
    (msg: Sent | undefined, cb?: (r: unknown) => void) => {
      sink?.push(msg ?? {});
      const r = reply(msg ?? {});
      if (cb) cb(r);
      return Promise.resolve(r);
    },
  );
}

/** The node's raw (snake_case) auth.status blob for a locked, secure-default node with a wallet. */
const RAW_LOCKED = { mode: 'per_transaction', method: 'password', state: 'locked', sign_armed: false, has_wallet: true };

afterEach(() => vi.restoreAllMocks());

describe('securityApi.getAuthStatus', () => {
  it('dispatches auth.status and normalizes the node blob to the secure model', async () => {
    const sink: Sent[] = [];
    mockSw((m) => (m.method === 'auth.status' ? RAW_LOCKED : { success: false }), sink);
    const store = createStore();
    const res = await store.dispatch(securityApi.endpoints.getAuthStatus.initiate());
    expect(sink[0]).toMatchObject({ action: 'authRpc', method: 'auth.status' });
    expect(res.data).toEqual({ mode: 'per_transaction', method: 'password', state: 'locked', signArmed: false, hasWallet: true });
  });

  it('defaults a garbage blob to the SECURE posture (never presents as unlocked)', async () => {
    mockSw(() => ({ state: 'read_only', mode: 'wat', method: 'bogus' }));
    const store = createStore();
    const res = await store.dispatch(securityApi.endpoints.getAuthStatus.initiate());
    // Unknown mode/method fall back to the secure default; state read_only is honoured.
    expect(res.data).toMatchObject({ mode: 'per_transaction', method: 'password', state: 'read_only' });
  });

  it('surfaces a node error (NODE_UNAVAILABLE) as an RTK error, never a throw', async () => {
    mockSw(() => ({ success: false, code: 'NODE_UNAVAILABLE', message: 'offline' }));
    const store = createStore();
    const res = await store.dispatch(securityApi.endpoints.getAuthStatus.initiate());
    expect(res.data).toBeUndefined();
    expect((res.error as { code?: string })?.code).toBe('NODE_UNAVAILABLE');
  });
});

describe('securityApi.getSignAuthority', () => {
  it('reports whether the node is the signing authority (#374)', async () => {
    mockSw((m) => (m.action === 'getSignAuthority' ? { nodeIsSigner: true } : { success: false }));
    const store = createStore();
    const res = await store.dispatch(securityApi.endpoints.getSignAuthority.initiate());
    expect(res.data).toEqual({ nodeIsSigner: true });
  });
});

describe('securityApi mutations map to the node auth.* methods', () => {
  it('setAuthMode forwards the target mode + credential params', async () => {
    const sink: Sent[] = [];
    mockSw(() => ({ ...RAW_LOCKED, mode: 'session_unlock_all', state: 'read_only' }), sink);
    const store = createStore();
    const res = await store.dispatch(
      securityApi.endpoints.setAuthMode.initiate({ mode: 'session_unlock_all', credential: { password: 'pw', totpCode: '123456' } }),
    );
    expect(sink[0]).toMatchObject({ action: 'authRpc', method: 'auth.set_mode', params: { mode: 'session_unlock_all', password: 'pw', totp_code: '123456' } });
    expect(res.data).toMatchObject({ mode: 'session_unlock_all', state: 'read_only' });
  });

  it('enrollTotp forwards the current-factor credential and returns the one-time secret/URI', async () => {
    const sink: Sent[] = [];
    mockSw(() => ({ secret_base32: 'ABCD2345', otpauth_uri: 'otpauth://totp/DIG?secret=ABCD2345' }), sink);
    const store = createStore();
    const res = await store.dispatch(securityApi.endpoints.enrollTotp.initiate({ password: 'pw' }));
    expect(sink[0]).toMatchObject({ action: 'authRpc', method: 'auth.enroll_totp', params: { password: 'pw' } });
    expect(res.data).toEqual({ secretBase32: 'ABCD2345', otpauthUri: 'otpauth://totp/DIG?secret=ABCD2345' });
  });

  it('signUnlock arms exactly one signature with a fresh credential', async () => {
    const sink: Sent[] = [];
    mockSw(() => ({ ...RAW_LOCKED, state: 'read_only', sign_armed: true }), sink);
    const store = createStore();
    const res = await store.dispatch(securityApi.endpoints.signUnlock.initiate({ password: 'pw', totpCode: '000111' }));
    expect(sink[0]).toMatchObject({ action: 'authRpc', method: 'auth.sign_unlock', params: { password: 'pw', totp_code: '000111' } });
    expect(res.data).toMatchObject({ signArmed: true });
  });

  it('lock forwards no credential', async () => {
    const sink: Sent[] = [];
    mockSw(() => RAW_LOCKED, sink);
    const store = createStore();
    await store.dispatch(securityApi.endpoints.lock.initiate());
    expect(sink[0]).toMatchObject({ action: 'authRpc', method: 'auth.lock' });
    expect(sink[0].params).toEqual({});
  });

  it('setAuthMethod switching to password carries no code (resets to password-only)', async () => {
    const sink: Sent[] = [];
    mockSw(() => RAW_LOCKED, sink);
    const store = createStore();
    await store.dispatch(securityApi.endpoints.setAuthMethod.initiate({ method: 'password', credential: { password: 'pw' } }));
    expect(sink[0]).toMatchObject({ action: 'authRpc', method: 'auth.set_method', params: { method: 'password', password: 'pw' } });
    expect(sink[0].params?.totp_code).toBeUndefined();
  });
});
