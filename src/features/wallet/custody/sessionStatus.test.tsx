import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/harness';
import { SessionStatus } from '@/features/wallet/custody/SessionStatus';

/**
 * The visible auto-lock countdown + explicit "Lock now" action (#76 P1-4), alongside
 * {@link AutoLockSetting} in Settings. Drives it over the mocked SW seam (`getLockState` +
 * `lockWallet`) — the same idiom as `walletSwitcher.test.tsx`.
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

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('SessionStatus (#76)', () => {
  it('renders nothing while locked/none — nothing to count down', async () => {
    mockSw(() => ({ lockState: 'locked', activeWalletId: null, unlockExpiry: null, activeIndex: 0 }));
    renderWithProviders(<SessionStatus />);
    await waitFor(() => expect(screen.queryByTestId('session-status')).not.toBeInTheDocument());
  });

  it('shows the minutes remaining until auto-lock while unlocked', async () => {
    const unlockExpiry = Date.now() + 12 * 60_000;
    mockSw(() => ({ lockState: 'unlocked', activeWalletId: 'w1', unlockExpiry, activeIndex: 0 }));
    renderWithProviders(<SessionStatus />);
    const countdown = await screen.findByTestId('session-status-countdown');
    expect(countdown.textContent).toMatch(/12/);
  });

  it('the Lock now button calls lockWallet on the SW', async () => {
    let lockState = 'unlocked';
    const sw = mockSw((m) => {
      if (m.action === 'lockWallet') {
        lockState = 'locked';
        return { lockState };
      }
      return { lockState, activeWalletId: 'w1', unlockExpiry: lockState === 'unlocked' ? Date.now() + 60_000 : null, activeIndex: 0 };
    });
    renderWithProviders(<SessionStatus />);
    fireEvent.click(await screen.findByTestId('session-status-lock-now'));
    await waitFor(() => {
      expect(sw).toHaveBeenCalledWith(expect.objectContaining({ action: 'lockWallet' }), expect.any(Function));
    });
  });
});
