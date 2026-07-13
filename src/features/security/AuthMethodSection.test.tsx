import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/harness';
import { AuthMethodSection } from '@/features/security/AuthMethodSection';
import type { AuthStatus } from '@/lib/node-auth';

interface Sent {
  action?: string;
  method?: string;
  params?: Record<string, unknown>;
}

function mkStatus(o: Partial<AuthStatus> = {}): AuthStatus {
  return { mode: 'per_transaction', method: 'password', state: 'locked', signArmed: false, hasWallet: true, ...o };
}

/**
 * Mock the SW seam. `auth.enroll_totp` returns a one-time secret/URI; `auth.unlock` accepts the code
 * '654321' (the verify step) and 401s otherwise; `auth.set_method` echoes. `sink` records envelopes.
 */
function mockSw(sink?: Sent[]) {
  (chrome.runtime as unknown as { sendMessage: unknown }).sendMessage = vi.fn(
    (msg: Sent | undefined, cb?: (r: unknown) => void) => {
      const m = msg ?? {};
      sink?.push(m);
      let r: unknown = { success: false };
      if (m.method === 'auth.enroll_totp') {
        r = { secret_base32: 'JBSWY3DPEHPK3PXP', otpauth_uri: 'otpauth://totp/DIG%20Node?secret=JBSWY3DPEHPK3PXP&issuer=DIG' };
      } else if (m.method === 'auth.unlock') {
        r = m.params?.totp_code === '654321'
          ? { mode: 'per_transaction', method: 'totp', state: 'read_only', sign_armed: false, has_wallet: true }
          : { success: false, code: -32030, message: 'unauthorized' };
      } else if (m.method === 'auth.set_method') {
        r = { mode: 'per_transaction', method: m.params?.method, state: 'locked', sign_armed: false, has_wallet: true };
      }
      if (cb) cb(r);
      return Promise.resolve(r);
    },
  );
}

afterEach(() => vi.restoreAllMocks());

describe('AuthMethodSection (SPEC §18.24)', () => {
  it('lists the methods and shows passkey as a DISABLED "coming soon" option (never a broken button)', () => {
    mockSw();
    renderWithProviders(<AuthMethodSection status={mkStatus()} />);
    expect(screen.getByTestId('security-method-passkey-soon')).toBeTruthy();
    expect((screen.getByTestId('security-passkey-enroll') as HTMLButtonElement).disabled).toBe(true);
  });

  it('enrolls TOTP: re-verifies the current factor, then shows the QR + secret + a real verify step', async () => {
    const sink: Sent[] = [];
    mockSw(sink);
    renderWithProviders(<AuthMethodSection status={mkStatus({ method: 'password' })} />);

    // Start enroll → current-factor form (password only, since the current method is password).
    fireEvent.click(screen.getByTestId('security-totp-enroll'));
    fireEvent.change(screen.getByTestId('security-totp-enroll-cred-password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByTestId('security-totp-enroll-cred-submit'));

    // The one-time secret + QR are provisioned.
    expect(await screen.findByTestId('security-totp-qr')).toBeTruthy();
    expect(screen.getByTestId('security-totp-secret').textContent).toBe('JBSWY3DPEHPK3PXP');
    const enrollCall = sink.find((s) => s.method === 'auth.enroll_totp');
    expect(enrollCall?.params).toMatchObject({ password: 'pw' });

    // Verify step: a WRONG code is rejected, a RIGHT code confirms the authenticator (real auth.unlock).
    fireEvent.change(screen.getByTestId('security-totp-verify-password'), { target: { value: 'pw' } });
    fireEvent.change(screen.getByTestId('security-totp-verify-totp'), { target: { value: '111111' } });
    fireEvent.click(screen.getByTestId('security-totp-verify-submit'));
    expect(await screen.findByTestId('security-totp-verify-error')).toBeTruthy();

    fireEvent.change(screen.getByTestId('security-totp-verify-totp'), { target: { value: '654321' } });
    fireEvent.click(screen.getByTestId('security-totp-verify-submit'));
    expect(await screen.findByTestId('security-totp-verified')).toBeTruthy();
  });

  it('when TOTP is active, offers a reset-to-password path that re-verifies the current factor (password + code)', async () => {
    const sink: Sent[] = [];
    mockSw(sink);
    renderWithProviders(<AuthMethodSection status={mkStatus({ method: 'totp' })} />);

    fireEvent.click(screen.getByTestId('security-method-reset'));
    // Reset re-verifies the CURRENT factor — password AND the live code (method is totp).
    fireEvent.change(screen.getByTestId('security-method-reset-cred-password'), { target: { value: 'pw' } });
    expect(screen.getByTestId('security-method-reset-cred-totp')).toBeTruthy();
    fireEvent.change(screen.getByTestId('security-method-reset-cred-totp'), { target: { value: '654321' } });
    fireEvent.click(screen.getByTestId('security-method-reset-cred-submit'));

    await waitFor(() => expect(sink.some((s) => s.method === 'auth.set_method')).toBe(true));
    const call = sink.find((s) => s.method === 'auth.set_method');
    expect(call?.params).toMatchObject({ method: 'password', password: 'pw', totp_code: '654321' });
  });
});
