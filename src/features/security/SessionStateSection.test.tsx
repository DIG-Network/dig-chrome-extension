import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/harness';
import { SessionStateSection } from '@/features/security/SessionStateSection';
import type { AuthStatus } from '@/lib/node-auth';

interface Sent {
  action?: string;
  method?: string;
  params?: Record<string, unknown>;
}

function mkStatus(o: Partial<AuthStatus> = {}): AuthStatus {
  return { mode: 'per_transaction', method: 'password', state: 'locked', signArmed: false, hasWallet: true, ...o };
}

function mockSw(sink?: Sent[]) {
  (chrome.runtime as unknown as { sendMessage: unknown }).sendMessage = vi.fn(
    (msg: Sent | undefined, cb?: (r: unknown) => void) => {
      const m = msg ?? {};
      sink?.push(m);
      let r: unknown = { success: false };
      if (m.method === 'auth.unlock') r = { mode: 'per_transaction', method: 'password', state: 'read_only', sign_armed: false, has_wallet: true };
      else if (m.method === 'auth.lock') r = { mode: 'per_transaction', method: 'password', state: 'locked', sign_armed: false, has_wallet: true };
      if (cb) cb(r);
      return Promise.resolve(r);
    },
  );
}

afterEach(() => vi.restoreAllMocks());

describe('SessionStateSection (SPEC §18.24)', () => {
  it('shows the LOCKED state with an unlock affordance, no lock button', () => {
    mockSw();
    renderWithProviders(<SessionStateSection status={mkStatus({ state: 'locked' })} />);
    expect(screen.getByTestId('security-session-state').textContent).toBeTruthy();
    expect(screen.getByTestId('security-unlock')).toBeTruthy();
    expect(screen.queryByTestId('security-lock')).toBeNull();
  });

  it('shows the read-only per-transaction description and a Lock button when unlocked', () => {
    mockSw();
    renderWithProviders(<SessionStateSection status={mkStatus({ state: 'read_only', mode: 'per_transaction' })} />);
    expect(screen.getByTestId('security-session-desc')).toBeTruthy();
    expect(screen.getByTestId('security-lock')).toBeTruthy();
    expect(screen.queryByTestId('security-unlock')).toBeNull();
  });

  it('surfaces the armed-signature indicator when a one-shot grant is armed', () => {
    mockSw();
    renderWithProviders(<SessionStateSection status={mkStatus({ state: 'read_only', signArmed: true })} />);
    expect(screen.getByTestId('security-session-armed')).toBeTruthy();
  });

  it('unlock opens a credential form and dispatches auth.unlock', async () => {
    const sink: Sent[] = [];
    mockSw(sink);
    renderWithProviders(<SessionStateSection status={mkStatus({ state: 'locked' })} />);
    fireEvent.click(screen.getByTestId('security-unlock'));
    fireEvent.change(screen.getByTestId('security-unlock-cred-password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByTestId('security-unlock-cred-submit'));
    await waitFor(() => expect(sink.some((s) => s.method === 'auth.unlock')).toBe(true));
  });

  it('lock dispatches auth.lock', async () => {
    const sink: Sent[] = [];
    mockSw(sink);
    renderWithProviders(<SessionStateSection status={mkStatus({ state: 'read_only' })} />);
    fireEvent.click(screen.getByTestId('security-lock'));
    await waitFor(() => expect(sink.some((s) => s.method === 'auth.lock')).toBe(true));
  });
});
