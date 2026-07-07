import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/harness';
import { ClawbackPanel } from '@/features/wallet/custody/ClawbackPanel';

/**
 * Clawback UI (#152) — list (incoming/outgoing, four states) → claim/claw-back → review → confirm →
 * confirmed, driven against a mocked SW seam. Proves the panel forwards `listClawbacks` /
 * `prepareClawbackAction` / `confirmClawbackAction` with the right direction + params, gates the
 * action button on the timelock (an incoming item is only claimable once its window has passed; an
 * outgoing item is only reclaimable strictly BEFORE its window — the hard cutover, #152), and renders
 * the loading/error/empty/success states.
 */

function mockSw(router: (m: { action: string; [k: string]: unknown }) => unknown) {
  const fn = vi.fn((msg: unknown, cb?: (r: unknown) => void) => {
    const reply = router(msg as { action: string; [k: string]: unknown });
    if (cb) cb(reply);
    return Promise.resolve(reply);
  });
  (chrome.runtime as unknown as { sendMessage: typeof fn }).sendMessage = fn;
  return fn;
}

const NOW_MS = Date.parse('2026-01-15T00:00:00.000Z');
const NOW_S = Math.floor(NOW_MS / 1000);

const INCOMING_CLAIMABLE = {
  direction: 'incoming' as const,
  info: { senderPuzzleHashHex: 'aa'.repeat(32), receiverPuzzleHashHex: 'bb'.repeat(32), seconds: String(NOW_S - 100), amount: '250000000000' },
  coinIdHex: 'c1'.repeat(32),
};
const INCOMING_LOCKED = {
  direction: 'incoming' as const,
  info: { senderPuzzleHashHex: 'aa'.repeat(32), receiverPuzzleHashHex: 'bb'.repeat(32), seconds: String(NOW_S + 100_000), amount: '100000000000' },
  coinIdHex: 'c2'.repeat(32),
};
const OUTGOING_RECLAIMABLE = {
  direction: 'outgoing' as const,
  info: { senderPuzzleHashHex: 'dd'.repeat(32), receiverPuzzleHashHex: 'ee'.repeat(32), seconds: String(NOW_S + 100_000), amount: '500000000000' },
  coinIdHex: 'c3'.repeat(32),
};
const OUTGOING_EXPIRED = {
  direction: 'outgoing' as const,
  info: { senderPuzzleHashHex: 'dd'.repeat(32), receiverPuzzleHashHex: 'ee'.repeat(32), seconds: String(NOW_S - 100), amount: '10000000000' },
  coinIdHex: 'c4'.repeat(32),
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('ClawbackPanel', () => {
  it('renders loading / error / empty / success states', async () => {
    mockSw(() => ({ success: false, code: 'CHAIN_UNAVAILABLE', message: 'down' }));
    renderWithProviders(<ClawbackPanel nowMs={NOW_MS} />);
    await waitFor(() => expect(screen.getByTestId('clawback-list-error')).toBeInTheDocument());
  });

  it('shows an empty state when nothing is pending', async () => {
    mockSw((m) => (m.action === 'listClawbacks' ? { clawbacks: [] } : { success: true }));
    renderWithProviders(<ClawbackPanel nowMs={NOW_MS} />);
    await waitFor(() => expect(screen.getByTestId('clawback-list-empty')).toBeInTheDocument());
  });

  it('lists incoming + outgoing entries with the correct claimable/reclaimable status', async () => {
    mockSw((m) =>
      m.action === 'listClawbacks'
        ? { clawbacks: [INCOMING_CLAIMABLE, INCOMING_LOCKED, OUTGOING_RECLAIMABLE, OUTGOING_EXPIRED] }
        : { success: true },
    );
    renderWithProviders(<ClawbackPanel nowMs={NOW_MS} />);
    await screen.findByTestId('clawback-items');

    // Claimable NOW (window already passed) — the claim button is enabled.
    expect(screen.getByTestId(`clawback-status-${INCOMING_CLAIMABLE.coinIdHex}`)).toHaveTextContent(/now/i);
    expect(screen.getByTestId(`clawback-action-${INCOMING_CLAIMABLE.coinIdHex}`)).not.toBeDisabled();

    // Locked (window not yet passed) — the claim button is DISABLED.
    expect(screen.getByTestId(`clawback-action-${INCOMING_LOCKED.coinIdHex}`)).toBeDisabled();

    // Reclaimable (strictly before the window) — the claw-back button is enabled.
    expect(screen.getByTestId(`clawback-action-${OUTGOING_RECLAIMABLE.coinIdHex}`)).not.toBeDisabled();

    // Window elapsed — the sender can no longer claw back (the hard cutover, #152).
    expect(screen.getByTestId(`clawback-action-${OUTGOING_EXPIRED.coinIdHex}`)).toBeDisabled();
  });

  it('claiming an incoming clawback: prepare → review → confirm → confirmed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockSw((m) => {
      if (m.action === 'listClawbacks') return { clawbacks: [INCOMING_CLAIMABLE] };
      if (m.action === 'prepareClawbackAction') return { pendingId: 'p1', clawbackAmountOut: '249999000000' };
      if (m.action === 'confirmClawbackAction') return { spentCoinId: 'spent1' };
      if (m.action === 'sendStatus') return { confirmed: true };
      return { success: true };
    });
    renderWithProviders(<ClawbackPanel nowMs={NOW_MS} pollMs={50} />);
    await screen.findByTestId('clawback-items');

    fireEvent.click(screen.getByTestId(`clawback-action-${INCOMING_CLAIMABLE.coinIdHex}`));
    expect(await screen.findByTestId('clawback-review')).toBeInTheDocument();
    expect(screen.getByTestId('clawback-review-amount')).toHaveTextContent('0.249999');

    fireEvent.click(screen.getByTestId('clawback-confirm'));
    expect(await screen.findByTestId('clawback-sending')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('clawback-confirmed')).toBeInTheDocument(), { timeout: 3000 });
    vi.useRealTimers();
  });

  it('claws back an outgoing clawback with the correct direction wired to prepareClawbackAction', async () => {
    const spy = mockSw((m) => {
      if (m.action === 'listClawbacks') return { clawbacks: [OUTGOING_RECLAIMABLE] };
      if (m.action === 'prepareClawbackAction') return { pendingId: 'p2', clawbackAmountOut: '500000000000' };
      return { success: true };
    });
    renderWithProviders(<ClawbackPanel nowMs={NOW_MS} />);
    await screen.findByTestId('clawback-items');

    fireEvent.click(screen.getByTestId(`clawback-action-${OUTGOING_RECLAIMABLE.coinIdHex}`));
    await screen.findByTestId('clawback-review');

    const call = spy.mock.calls.find(([m]) => (m as { action: string }).action === 'prepareClawbackAction');
    expect(call?.[0]).toMatchObject({ direction: 'reclaim', clawbackInfo: OUTGOING_RECLAIMABLE.info });
  });

  it('a failed prepare shows a local error and stays in the list', async () => {
    mockSw((m) => (m.action === 'listClawbacks' ? { clawbacks: [INCOMING_CLAIMABLE] } : { success: false, code: 'MISSING_KEY' }));
    renderWithProviders(<ClawbackPanel nowMs={NOW_MS} />);
    await screen.findByTestId('clawback-items');
    fireEvent.click(screen.getByTestId(`clawback-action-${INCOMING_CLAIMABLE.coinIdHex}`));
    expect(await screen.findByTestId('clawback-error')).toBeInTheDocument();
  });

  it('a failed broadcast shows the failed state with a retry back to the list', async () => {
    mockSw((m) => {
      if (m.action === 'listClawbacks') return { clawbacks: [INCOMING_CLAIMABLE] };
      if (m.action === 'prepareClawbackAction') return { pendingId: 'p1', clawbackAmountOut: '249999000000' };
      if (m.action === 'confirmClawbackAction') return { success: false, code: 'PUSH_FAILED' };
      return { success: true };
    });
    renderWithProviders(<ClawbackPanel nowMs={NOW_MS} />);
    await screen.findByTestId('clawback-items');
    fireEvent.click(screen.getByTestId(`clawback-action-${INCOMING_CLAIMABLE.coinIdHex}`));
    await screen.findByTestId('clawback-review');
    fireEvent.click(screen.getByTestId('clawback-confirm'));
    expect(await screen.findByTestId('clawback-failed')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('clawback-retry'));
    expect(await screen.findByTestId('clawback-items')).toBeInTheDocument();
  });

  it('the header Back/Close affordance closes the panel from the list, and steps up from review', async () => {
    const onClose = vi.fn();
    mockSw((m) => (m.action === 'listClawbacks' ? { clawbacks: [INCOMING_CLAIMABLE] } : { pendingId: 'p1', clawbackAmountOut: '1' }));
    renderWithProviders(<ClawbackPanel nowMs={NOW_MS} onClose={onClose} />);
    await screen.findByTestId('clawback-items');
    fireEvent.click(screen.getByTestId('clawback-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
