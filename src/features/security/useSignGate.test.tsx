import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/harness';
import { useSignGate } from '@/features/security/useSignGate';
import { SignUnlockModal } from '@/features/security/SignUnlockModal';

interface Sent {
  action?: string;
  method?: string;
  params?: Record<string, unknown>;
}

/**
 * Mock the SW seam for the gate: `getSignAuthority` reports whether the node signs; `auth.status`
 * reports the mode; `auth.sign_unlock` accepts the RIGHT password ('good') and 401s anything else.
 */
function mockSw(opts: { nodeIsSigner: boolean; mode?: string; state?: string }, sink?: Sent[]) {
  const { nodeIsSigner, mode = 'per_transaction', state = 'locked' } = opts;
  (chrome.runtime as unknown as { sendMessage: unknown }).sendMessage = vi.fn(
    (msg: Sent | undefined, cb?: (r: unknown) => void) => {
      const m = msg ?? {};
      sink?.push(m);
      let r: unknown = { success: false };
      if (m.action === 'getSignAuthority') r = { nodeIsSigner };
      else if (m.method === 'auth.status') r = { mode, method: 'password', state, sign_armed: false, has_wallet: true };
      else if (m.method === 'auth.sign_unlock') {
        r = m.params?.password === 'good'
          ? { mode, method: 'password', state: 'read_only', sign_armed: true, has_wallet: true }
          : { success: false, code: -32030, message: 'unauthorized' };
      }
      if (cb) cb(r);
      return Promise.resolve(r);
    },
  );
}

/** A tiny host that wires the gate to a "Sign" button + renders the modal, so we drive it end-to-end. */
function GateHost({ onSigned }: { onSigned: () => void }) {
  const gate = useSignGate();
  return (
    <>
      <button type="button" data-testid="go" onClick={() => gate.guard(onSigned)}>
        sign
      </button>
      <SignUnlockModal {...gate.modal} />
    </>
  );
}

afterEach(() => vi.restoreAllMocks());

describe('useSignGate — per-transaction unlock gate (SPEC §18.24)', () => {
  it('is INERT when the node is not the signer: signs immediately, no prompt (local-vault default)', async () => {
    const signed = vi.fn();
    mockSw({ nodeIsSigner: false });
    renderWithProviders(<GateHost onSigned={signed} />);
    fireEvent.click(screen.getByTestId('go'));
    await waitFor(() => expect(signed).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('sign-unlock-modal')).toBeNull();
  });

  it('PROMPTS before signing in per_transaction mode and signs only AFTER a valid unlock', async () => {
    const signed = vi.fn();
    const sink: Sent[] = [];
    mockSw({ nodeIsSigner: true, mode: 'per_transaction' }, sink);
    renderWithProviders(<GateHost onSigned={signed} />);
    // Let the status query resolve so the gate knows the mode.
    await waitFor(() => expect(sink.some((s) => s.method === 'auth.status')).toBe(true));

    fireEvent.click(screen.getByTestId('go'));
    // The prompt is shown and the sign op has NOT run yet — the gate blocks it.
    expect(await screen.findByTestId('sign-unlock-modal')).toBeTruthy();
    expect(signed).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId('sign-unlock-password'), { target: { value: 'good' } });
    fireEvent.click(screen.getByTestId('sign-unlock-submit'));

    // auth.sign_unlock is dispatched, then the stashed op runs exactly once; the modal closes.
    await waitFor(() => expect(signed).toHaveBeenCalledTimes(1));
    expect(sink.some((s) => s.method === 'auth.sign_unlock' && s.params?.password === 'good')).toBe(true);
    await waitFor(() => expect(screen.queryByTestId('sign-unlock-modal')).toBeNull());
  });

  it('a WRONG credential keeps the prompt open, surfaces the error, and never signs', async () => {
    const signed = vi.fn();
    const sink: Sent[] = [];
    mockSw({ nodeIsSigner: true, mode: 'per_transaction' }, sink);
    renderWithProviders(<GateHost onSigned={signed} />);
    await waitFor(() => expect(sink.some((s) => s.method === 'auth.status')).toBe(true));
    fireEvent.click(screen.getByTestId('go'));
    await screen.findByTestId('sign-unlock-modal');

    fireEvent.change(screen.getByTestId('sign-unlock-password'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByTestId('sign-unlock-submit'));

    expect(await screen.findByTestId('sign-unlock-error')).toBeTruthy();
    expect(signed).not.toHaveBeenCalled();
    expect(screen.getByTestId('sign-unlock-modal')).toBeTruthy(); // still open for retry
  });

  it('does NOT prompt in session_unlock_all once the session is unlocked (read_only)', async () => {
    const signed = vi.fn();
    const sink: Sent[] = [];
    mockSw({ nodeIsSigner: true, mode: 'session_unlock_all', state: 'read_only' }, sink);
    renderWithProviders(<GateHost onSigned={signed} />);
    await waitFor(() => expect(sink.some((s) => s.method === 'auth.status')).toBe(true));

    fireEvent.click(screen.getByTestId('go'));
    await waitFor(() => expect(signed).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('sign-unlock-modal')).toBeNull();
  });

  it('cancel abandons the signing op (nothing armed, nothing signed)', async () => {
    const signed = vi.fn();
    const sink: Sent[] = [];
    mockSw({ nodeIsSigner: true, mode: 'per_transaction' }, sink);
    renderWithProviders(<GateHost onSigned={signed} />);
    await waitFor(() => expect(sink.some((s) => s.method === 'auth.status')).toBe(true));
    fireEvent.click(screen.getByTestId('go'));
    await screen.findByTestId('sign-unlock-modal');
    fireEvent.click(screen.getByTestId('sign-unlock-cancel'));
    await waitFor(() => expect(screen.queryByTestId('sign-unlock-modal')).toBeNull());
    expect(signed).not.toHaveBeenCalled();
  });
});
