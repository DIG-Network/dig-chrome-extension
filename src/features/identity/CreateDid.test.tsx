import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { axe } from 'jest-axe';
import { renderWithProviders } from '@/test/harness';
import { createStore } from '@/app/store';
import { setActiveDerivationIndex } from '@/features/wallet/walletSlice';
import { CreateDid } from '@/features/identity/CreateDid';
import type { DidCreateSummary } from '@/offscreen/dids';

const LAUNCHER = 'ab'.repeat(32);

function summary(over: Partial<DidCreateSummary> = {}): DidCreateSummary {
  return {
    launcherId: LAUNCHER,
    p2PuzzleHashHex: 'ef'.repeat(32),
    fee: '0',
    coinCount: 1,
    ...over,
  };
}

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

describe('CreateDid', () => {
  it('rejects a malformed fee before building', async () => {
    const sw = mockSw(() => ({ success: true }));
    renderWithProviders(<CreateDid onDone={() => {}} />);
    fireEvent.change(screen.getByTestId('did-create-fee'), { target: { value: 'not-a-number' } });
    fireEvent.click(screen.getByTestId('did-create-review'));
    expect(await screen.findByTestId('did-create-fee-error')).toBeInTheDocument();
    expect(sw).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'prepareDidCreate' }), expect.any(Function));
  });

  it('form → review shows the decoded fee summary', async () => {
    mockSw((m) => {
      if (m.action === 'prepareDidCreate') return { pendingId: 'p1', launcherId: LAUNCHER, didCreateSummary: summary() };
      return { success: true };
    });
    renderWithProviders(<CreateDid onDone={() => {}} />);
    fireEvent.click(screen.getByTestId('did-create-review'));
    expect(await screen.findByTestId('did-create-review-panel')).toBeInTheDocument();
    expect(screen.getByTestId('did-create-review-fee')).toBeInTheDocument();
  });

  it('review → confirm → sending → confirmed (happy path with polling)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const sw = mockSw((m) => {
      if (m.action === 'prepareDidCreate') return { pendingId: 'p1', launcherId: LAUNCHER, didCreateSummary: summary() };
      if (m.action === 'confirmDidCreate') return { spentCoinId: 'coin1' };
      if (m.action === 'sendStatus') return { confirmed: true };
      return { success: true };
    });
    renderWithProviders(<CreateDid onDone={() => {}} pollMs={50} />);

    fireEvent.click(screen.getByTestId('did-create-review'));
    fireEvent.click(await screen.findByTestId('did-create-confirm'));

    expect(await screen.findByTestId('did-create-sending')).toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(60);
    expect(await screen.findByTestId('did-create-confirmed')).toBeInTheDocument();
    expect(screen.getByTestId('did-create-launcher-id')).toHaveTextContent(LAUNCHER);
    expect(sw).toHaveBeenCalledWith(expect.objectContaining({ action: 'prepareDidCreate' }), expect.any(Function));
  });

  it('shows the terminal failure state when the broadcast is rejected', async () => {
    mockSw((m) => {
      if (m.action === 'prepareDidCreate') return { pendingId: 'p1', launcherId: LAUNCHER, didCreateSummary: summary() };
      if (m.action === 'confirmDidCreate') return { success: false, code: 'PUSH_FAILED' };
      return { success: true };
    });
    renderWithProviders(<CreateDid onDone={() => {}} />);
    fireEvent.click(screen.getByTestId('did-create-review'));
    fireEvent.click(await screen.findByTestId('did-create-confirm'));
    expect(await screen.findByTestId('did-create-failed')).toBeInTheDocument();
  });

  // #179: the build-error branch used to collapse every failure to one generic "try again" string,
  // hiding whether the cause was an unfunded active index, fragmented coins, or something else.
  it('NO_XCH_COINS names the active derivation index and never says "try again"', async () => {
    mockSw((m) => (m.action === 'prepareDidCreate' ? { success: false, code: 'NO_XCH_COINS' } : { success: true }));
    const store = createStore();
    store.dispatch(setActiveDerivationIndex(3));
    renderWithProviders(<CreateDid onDone={() => {}} />, { store });
    fireEvent.click(screen.getByTestId('did-create-review'));
    const error = await screen.findByTestId('did-create-build-error');
    expect(error).toHaveTextContent('3');
    expect(error).not.toHaveTextContent(/try again/i);
  });

  it('NO_SUITABLE_COIN shows the insufficient-total-funds message', async () => {
    mockSw((m) => (m.action === 'prepareDidCreate' ? { success: false, code: 'NO_SUITABLE_COIN' } : { success: true }));
    renderWithProviders(<CreateDid onDone={() => {}} />);
    fireEvent.click(screen.getByTestId('did-create-review'));
    const error = await screen.findByTestId('did-create-build-error');
    expect(error).not.toHaveTextContent(/try again/i);
  });

  it('an unrecognized failure surfaces the ACTUAL error message, never a canned "try again"', async () => {
    mockSw((m) =>
      m.action === 'prepareDidCreate' ? { success: false, code: 'WASM_ERROR', message: 'clvm raise (SPEND_ASSERT)' } : { success: true },
    );
    renderWithProviders(<CreateDid onDone={() => {}} />);
    fireEvent.click(screen.getByTestId('did-create-review'));
    const error = await screen.findByTestId('did-create-build-error');
    expect(error).toHaveTextContent('clvm raise (SPEND_ASSERT)');
    expect(error).not.toHaveTextContent(/try again/i);
  });

  it('has no WCAG violations (create form)', async () => {
    mockSw(() => ({ success: true }));
    const { container } = renderWithProviders(<CreateDid onDone={() => {}} />);
    expect((await axe(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
  });
});
