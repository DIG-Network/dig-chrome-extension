import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/harness';
import { IndexNavigator } from '@/features/wallet/custody/IndexNavigator';

/**
 * Component tests for the single active-derivation-index navigator (#165). The active index lives
 * behind the SW seam (persisted per wallet in the registry), so a STATEFUL `chrome.runtime.sendMessage`
 * mock models one wallet's `activeIndex` — the real RTK store + tag invalidation drive the refetch,
 * exactly as in the shipped extension. No offscreen vault/derivation involved here (covered by
 * scan.test.ts / vault.test.ts); this proves the UI wiring only.
 */
function mockIndexState(initial = 0) {
  let activeIndex = initial;
  const calls: { action: string; [k: string]: unknown }[] = [];
  const router = (m: { action: string; [k: string]: unknown }) => {
    calls.push(m);
    switch (m.action) {
      case 'getLockState':
        return { lockState: 'unlocked', activeWalletId: 'w1', activeIndex };
      case 'setActiveIndex': {
        const requested = Math.max(0, Math.floor(m.index as number));
        activeIndex = requested;
        return { success: true, activeIndex };
      }
      default:
        return { success: true };
    }
  };
  const fn = vi.fn((msg: unknown, cb?: (r: unknown) => void) => {
    const reply = router(msg as { action: string; [k: string]: unknown });
    if (cb) cb(reply);
    return Promise.resolve(reply);
  });
  (chrome.runtime as unknown as { sendMessage: typeof fn }).sendMessage = fn;
  return { fn, calls };
}

afterEach(() => vi.restoreAllMocks());

describe('IndexNavigator (#165 — single active derivation index)', () => {
  it('shows the active index (default 0)', async () => {
    mockIndexState(0);
    renderWithProviders(<IndexNavigator />);
    expect(await screen.findByTestId('index-nav-current')).toHaveTextContent('0');
  });

  it('next advances the active index and persists it', async () => {
    const { calls } = mockIndexState(0);
    renderWithProviders(<IndexNavigator />);
    await screen.findByTestId('index-nav-current');
    fireEvent.click(screen.getByTestId('index-nav-next'));
    await waitFor(() => expect(screen.getByTestId('index-nav-current')).toHaveTextContent('1'));
    expect(calls.some((c) => c.action === 'setActiveIndex' && c.index === 1)).toBe(true);
  });

  it('prev retreats the active index, and is disabled at index 0', async () => {
    mockIndexState(2);
    renderWithProviders(<IndexNavigator />);
    await waitFor(() => expect(screen.getByTestId('index-nav-current')).toHaveTextContent('2'));
    expect(screen.getByTestId('index-nav-prev')).not.toBeDisabled();
    fireEvent.click(screen.getByTestId('index-nav-prev'));
    await waitFor(() => expect(screen.getByTestId('index-nav-current')).toHaveTextContent('1'));
    fireEvent.click(screen.getByTestId('index-nav-prev'));
    await waitFor(() => expect(screen.getByTestId('index-nav-current')).toHaveTextContent('0'));
    expect(screen.getByTestId('index-nav-prev')).toBeDisabled(); // never navigates below 0
  });

  it('jump-to-index: clicking the current index opens an editable field that navigates on submit', async () => {
    mockIndexState(0);
    renderWithProviders(<IndexNavigator />);
    fireEvent.click(await screen.findByTestId('index-nav-current'));
    const input = screen.getByTestId('index-nav-input');
    fireEvent.change(input, { target: { value: '7' } });
    fireEvent.submit(input);
    await waitFor(() => expect(screen.getByTestId('index-nav-current')).toHaveTextContent('7'));
  });

  it('a failed navigation reverts to the previous index and shows an error', async () => {
    mockIndexState(0);
    (chrome.runtime as unknown as { sendMessage: (msg: unknown, cb?: (r: unknown) => void) => Promise<unknown> }).sendMessage = vi.fn(
      (msg: unknown, cb?: (r: unknown) => void) => {
        const m = msg as { action: string };
        const reply =
          m.action === 'getLockState'
            ? { lockState: 'unlocked', activeWalletId: 'w1', activeIndex: 0 }
            : m.action === 'setActiveIndex'
              ? { success: false, code: 'NO_WALLET', message: 'no wallet' }
              : { success: true };
        if (cb) cb(reply);
        return Promise.resolve(reply);
      },
    );
    renderWithProviders(<IndexNavigator />);
    await screen.findByTestId('index-nav-current');
    fireEvent.click(screen.getByTestId('index-nav-next'));
    await waitFor(() => expect(screen.getByTestId('index-nav-error')).toBeInTheDocument());
    expect(screen.getByTestId('index-nav-current')).toHaveTextContent('0'); // reverted
  });
});
