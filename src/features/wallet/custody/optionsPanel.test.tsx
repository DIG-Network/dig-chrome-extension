import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { axe } from 'jest-axe';
import { renderWithProviders } from '@/test/harness';
import { OptionsPanel } from '@/features/wallet/custody/OptionsPanel';
import type { OptionMintSummary, OptionRecord } from '@/offscreen/optionContracts';

const LAUNCHER = 'ab'.repeat(32);

function record(over: Partial<OptionRecord> = {}): OptionRecord {
  return {
    launcherId: LAUNCHER,
    creatorPuzzleHashHex: 'cc'.repeat(32),
    holderPuzzleHashHex: 'cc'.repeat(32),
    expirationSeconds: String(Math.floor(Date.now() / 1000) + 30 * 86_400),
    underlyingAmount: '1000000000000',
    strikeAmount: '500000000000',
    underlyingLockParentCoinId: 'dd'.repeat(32),
    coinIdHex: 'ee'.repeat(32),
    ...over,
  };
}

function summary(over: Partial<OptionMintSummary> = {}): OptionMintSummary {
  return { ...record(), fee: '0', coinCount: 3, ...over };
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

describe('OptionsPanel — mint', () => {
  it('requires underlying/strike/expiration before building (no prepare call on empty form)', async () => {
    const sw = mockSw(() => ({ success: true }));
    renderWithProviders(<OptionsPanel onDone={() => {}} />);
    fireEvent.click(screen.getByTestId('options-mint-review'));
    expect(await screen.findByTestId('options-mint-underlying-error')).toBeInTheDocument();
    expect(sw).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'prepareOptionMint' }), expect.any(Function));
  });

  it('form → review shows the decoded summary (underlying + strike + fee)', async () => {
    mockSw((m) => (m.action === 'prepareOptionMint' ? { pendingId: 'p1', optionMintSummary: summary(), optionRecord: record() } : { success: true }));
    renderWithProviders(<OptionsPanel onDone={() => {}} />);
    fireEvent.change(screen.getByTestId('options-mint-underlying'), { target: { value: '1' } });
    fireEvent.change(screen.getByTestId('options-mint-strike'), { target: { value: '0.5' } });
    fireEvent.change(screen.getByTestId('options-mint-expires'), { target: { value: '30' } });
    fireEvent.click(screen.getByTestId('options-mint-review'));

    expect(await screen.findByTestId('options-mint-review-panel')).toBeInTheDocument();
    expect(screen.getByTestId('options-mint-review-underlying')).toHaveTextContent('1 XCH');
    expect(screen.getByTestId('options-mint-review-strike')).toHaveTextContent('0.5 XCH');
  });

  it('review → confirm → sending → confirmed (happy path with polling)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const sw = mockSw((m) => {
      if (m.action === 'prepareOptionMint') return { pendingId: 'p1', optionMintSummary: summary(), optionRecord: record() };
      if (m.action === 'confirmOptionMint') return { spentCoinId: 'coin1' };
      if (m.action === 'sendStatus') return { confirmed: true };
      return { success: true };
    });
    renderWithProviders(<OptionsPanel onDone={() => {}} pollMs={50} />);
    fireEvent.change(screen.getByTestId('options-mint-underlying'), { target: { value: '1' } });
    fireEvent.change(screen.getByTestId('options-mint-strike'), { target: { value: '0.5' } });
    fireEvent.change(screen.getByTestId('options-mint-expires'), { target: { value: '30' } });
    fireEvent.click(screen.getByTestId('options-mint-review'));
    fireEvent.click(await screen.findByTestId('options-mint-confirm'));

    expect(await screen.findByTestId('options-mint-sending')).toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(60);
    expect(await screen.findByTestId('options-mint-confirmed')).toBeInTheDocument();
    expect(screen.getByTestId('options-mint-launcher-id')).toHaveTextContent(LAUNCHER);
    expect(sw).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'confirmOptionMint', pendingId: 'p1', optionRecord: expect.objectContaining({ launcherId: LAUNCHER }) }),
      expect.any(Function),
    );
  });

  it('shows the terminal failure state when the broadcast is rejected', async () => {
    mockSw((m) => {
      if (m.action === 'prepareOptionMint') return { pendingId: 'p1', optionMintSummary: summary(), optionRecord: record() };
      if (m.action === 'confirmOptionMint') return { success: false, code: 'PUSH_FAILED' };
      return { success: true };
    });
    renderWithProviders(<OptionsPanel onDone={() => {}} />);
    fireEvent.change(screen.getByTestId('options-mint-underlying'), { target: { value: '1' } });
    fireEvent.change(screen.getByTestId('options-mint-strike'), { target: { value: '0.5' } });
    fireEvent.change(screen.getByTestId('options-mint-expires'), { target: { value: '30' } });
    fireEvent.click(screen.getByTestId('options-mint-review'));
    fireEvent.click(await screen.findByTestId('options-mint-confirm'));
    expect(await screen.findByTestId('options-mint-failed')).toBeInTheDocument();
  });
});

describe('OptionsPanel — list + exercise', () => {
  it('shows the empty state with no minted options', async () => {
    mockSw((m) => (m.action === 'getOptions' ? { options: [] } : { success: true }));
    renderWithProviders(<OptionsPanel onDone={() => {}} />);
    fireEvent.click(screen.getByTestId('options-mode-list'));
    expect(await screen.findByTestId('options-list-empty')).toBeInTheDocument();
  });

  it('lists a minted OPEN option with an Exercise action', async () => {
    mockSw((m) => (m.action === 'getOptions' ? { options: [{ record: record(), createdAt: Date.now(), status: 'open' }] } : { success: true }));
    renderWithProviders(<OptionsPanel onDone={() => {}} />);
    fireEvent.click(screen.getByTestId('options-mode-list'));
    expect(await screen.findByTestId(`options-row-${LAUNCHER}`)).toBeInTheDocument();
    expect(screen.getByTestId(`options-row-status-${LAUNCHER}`)).toHaveTextContent(/open/i);
    expect(screen.getByTestId(`options-exercise-${LAUNCHER}`)).toBeInTheDocument();
  });

  it('an EXERCISED option shows no Exercise action', async () => {
    mockSw((m) => (m.action === 'getOptions' ? { options: [{ record: record(), createdAt: Date.now(), status: 'exercised' }] } : { success: true }));
    renderWithProviders(<OptionsPanel onDone={() => {}} />);
    fireEvent.click(screen.getByTestId('options-mode-list'));
    await screen.findByTestId(`options-row-${LAUNCHER}`);
    expect(screen.queryByTestId(`options-exercise-${LAUNCHER}`)).not.toBeInTheDocument();
  });

  it('an EXPIRED (but still open) option shows no Exercise action', async () => {
    const expired = record({ expirationSeconds: '1' });
    mockSw((m) => (m.action === 'getOptions' ? { options: [{ record: expired, createdAt: Date.now(), status: 'open' }] } : { success: true }));
    renderWithProviders(<OptionsPanel onDone={() => {}} />);
    fireEvent.click(screen.getByTestId('options-mode-list'));
    await screen.findByTestId(`options-row-${LAUNCHER}`);
    expect(screen.getByTestId(`options-row-status-${LAUNCHER}`)).toHaveTextContent(/expired/i);
    expect(screen.queryByTestId(`options-exercise-${LAUNCHER}`)).not.toBeInTheDocument();
  });

  it('exercise: review → confirm → sending → confirmed (happy path with polling)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockSw((m) => {
      if (m.action === 'getOptions') return { options: [{ record: record(), createdAt: Date.now(), status: 'open' }] };
      if (m.action === 'prepareOptionExercise') return { pendingId: 'ex1', optionExerciseSummary: { launcherId: LAUNCHER, strikeAmount: '500000000000', underlyingAmount: '1000000000000', fee: '0', coinCount: 5 } };
      if (m.action === 'confirmOptionExercise') return { spentCoinId: 'coinEx1' };
      if (m.action === 'sendStatus') return { confirmed: true };
      return { success: true };
    });
    renderWithProviders(<OptionsPanel onDone={() => {}} pollMs={50} />);
    fireEvent.click(screen.getByTestId('options-mode-list'));
    fireEvent.click(await screen.findByTestId(`options-exercise-${LAUNCHER}`));
    fireEvent.click(await screen.findByTestId(`options-exercise-confirm-${LAUNCHER}`));
    expect(await screen.findByTestId('options-exercise-sending')).toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(60);
    expect(await screen.findByTestId('options-exercise-confirmed')).toBeInTheDocument();
  });

  it('has no WCAG violations (options panel)', async () => {
    mockSw((m) => (m.action === 'getOptions' ? { options: [] } : { success: true }));
    const { container } = renderWithProviders(<OptionsPanel onDone={() => {}} />);
    expect((await axe(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
  });
});
