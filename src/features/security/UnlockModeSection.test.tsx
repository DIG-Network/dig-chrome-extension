import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/harness';
import { UnlockModeSection } from '@/features/security/UnlockModeSection';
import type { AuthStatus } from '@/lib/node-auth';

interface Sent {
  action?: string;
  method?: string;
  params?: Record<string, unknown>;
}

function mkStatus(o: Partial<AuthStatus> = {}): AuthStatus {
  return { mode: 'per_transaction', method: 'password', state: 'read_only', signArmed: false, hasWallet: true, ...o };
}

/** Mock the SW seam; `set_mode` echoes the requested mode. `sink` records dispatched envelopes. */
function mockSw(sink?: Sent[]) {
  (chrome.runtime as unknown as { sendMessage: unknown }).sendMessage = vi.fn(
    (msg: Sent | undefined, cb?: (r: unknown) => void) => {
      const m = msg ?? {};
      sink?.push(m);
      let r: unknown = { success: false };
      if (m.method === 'auth.set_mode') {
        r = { mode: m.params?.mode, method: 'password', state: 'read_only', sign_armed: false, has_wallet: true };
      }
      if (cb) cb(r);
      return Promise.resolve(r);
    },
  );
}

afterEach(() => vi.restoreAllMocks());

describe('UnlockModeSection (SPEC §18.24)', () => {
  it('renders both modes and marks per_transaction selected by default', () => {
    mockSw();
    renderWithProviders(<UnlockModeSection status={mkStatus({ mode: 'per_transaction' })} />);
    expect((screen.getByTestId('security-mode-per-transaction-input') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('security-mode-session-all-input') as HTMLInputElement).checked).toBe(false);
  });

  it('switching TO session_unlock_all requires the current factor (prompts, does NOT apply yet)', async () => {
    const sink: Sent[] = [];
    mockSw(sink);
    renderWithProviders(<UnlockModeSection status={mkStatus({ mode: 'per_transaction' })} />);

    fireEvent.click(screen.getByTestId('security-mode-session-all-input'));
    // A confirmation credential prompt appears; NO set_mode dispatched until it is submitted.
    expect(await screen.findByTestId('security-mode-confirm')).toBeTruthy();
    expect(sink.some((s) => s.method === 'auth.set_mode')).toBe(false);

    fireEvent.change(screen.getByTestId('security-mode-cred-password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByTestId('security-mode-cred-submit'));
    await waitFor(() => expect(sink.some((s) => s.method === 'auth.set_mode')).toBe(true));
    const call = sink.find((s) => s.method === 'auth.set_mode');
    expect(call?.params).toMatchObject({ mode: 'session_unlock_all', password: 'pw' });
  });

  it('switching BACK to per_transaction (tightening) applies immediately with no credential', async () => {
    const sink: Sent[] = [];
    mockSw(sink);
    renderWithProviders(<UnlockModeSection status={mkStatus({ mode: 'session_unlock_all' })} />);

    fireEvent.click(screen.getByTestId('security-mode-per-transaction-input'));
    await waitFor(() => expect(sink.some((s) => s.method === 'auth.set_mode')).toBe(true));
    const call = sink.find((s) => s.method === 'auth.set_mode');
    expect(call?.params).toEqual({ mode: 'per_transaction' });
    expect(screen.queryByTestId('security-mode-confirm')).toBeNull();
  });
});
