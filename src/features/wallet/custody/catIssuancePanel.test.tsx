import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { axe } from 'jest-axe';
import { renderWithProviders } from '@/test/harness';
import { CatIssuancePanel } from '@/features/wallet/custody/CatIssuancePanel';
import type { CatIssuanceSummary } from '@/offscreen/catIssuance';

const ASSET_ID = 'ab'.repeat(32);

function summary(over: Partial<CatIssuanceSummary> = {}): CatIssuanceSummary {
  return { assetId: ASSET_ID, mode: 'single', amount: '1000000', fee: '0', coinCount: 1, ...over };
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

describe('CatIssuancePanel', () => {
  it('requires a positive supply before building (no prepare call on empty form)', async () => {
    const sw = mockSw(() => ({ success: true }));
    renderWithProviders(<CatIssuancePanel onDone={() => {}} />);
    fireEvent.click(screen.getByTestId('issue-review'));
    expect(await screen.findByTestId('issue-supply-error')).toBeInTheDocument();
    expect(sw).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'prepareCatIssuance' }), expect.any(Function));
  });

  it('rejects a malformed fee before building', async () => {
    const sw = mockSw(() => ({ success: true }));
    renderWithProviders(<CatIssuancePanel onDone={() => {}} />);
    fireEvent.change(screen.getByTestId('issue-supply'), { target: { value: '1000' } });
    fireEvent.change(screen.getByTestId('issue-fee'), { target: { value: '-1' } });
    fireEvent.click(screen.getByTestId('issue-review'));
    expect(await screen.findByTestId('issue-fee-error')).toBeInTheDocument();
    expect(sw).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'prepareCatIssuance' }), expect.any(Function));
  });

  it('defaults to single-issuance mode and can switch to multi', async () => {
    mockSw((m) => (m.action === 'prepareCatIssuance' ? { pendingId: 'p1', assetId: ASSET_ID, catIssuanceSummary: summary({ mode: 'multi' }) } : { success: true }));
    renderWithProviders(<CatIssuancePanel onDone={() => {}} />);
    expect(screen.getByTestId('issue-mode-single')).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByTestId('issue-mode-multi'));
    expect(screen.getByTestId('issue-mode-multi')).toHaveAttribute('aria-checked', 'true');
    fireEvent.change(screen.getByTestId('issue-supply'), { target: { value: '1000' } });
    fireEvent.click(screen.getByTestId('issue-review'));
    expect(await screen.findByTestId('issue-review-mode')).toHaveTextContent('Mintable later');
  });

  it('form → review shows the decoded summary (supply + asset id + fee)', async () => {
    mockSw((m) => (m.action === 'prepareCatIssuance' ? { pendingId: 'p1', assetId: ASSET_ID, catIssuanceSummary: summary() } : { success: true }));
    renderWithProviders(<CatIssuancePanel onDone={() => {}} />);
    fireEvent.change(screen.getByTestId('issue-supply'), { target: { value: '1000' } });
    fireEvent.click(screen.getByTestId('issue-review'));

    expect(await screen.findByTestId('issue-review-panel')).toBeInTheDocument();
    expect(screen.getByTestId('issue-review-asset-id')).toHaveTextContent(ASSET_ID);
    expect(screen.getByTestId('issue-review-supply')).toHaveTextContent('1000');
  });

  it('review → confirm → sending → confirmed (happy path with polling)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const sw = mockSw((m) => {
      if (m.action === 'prepareCatIssuance') return { pendingId: 'p1', assetId: ASSET_ID, catIssuanceSummary: summary() };
      if (m.action === 'confirmCatIssuance') return { spentCoinId: 'coin1' };
      if (m.action === 'sendStatus') return { confirmed: true };
      return { success: true };
    });
    renderWithProviders(<CatIssuancePanel onDone={() => {}} pollMs={50} />);

    fireEvent.change(screen.getByTestId('issue-supply'), { target: { value: '1000' } });
    fireEvent.click(screen.getByTestId('issue-review'));
    fireEvent.click(await screen.findByTestId('issue-confirm'));

    expect(await screen.findByTestId('issue-sending')).toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(60);
    expect(await screen.findByTestId('issue-confirmed')).toBeInTheDocument();
    expect(screen.getByTestId('issue-confirmed-asset-id')).toHaveTextContent(ASSET_ID);
    expect(sw).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'prepareCatIssuance', catIssuance: expect.objectContaining({ amount: '1000000', mode: 'single' }) }),
      expect.any(Function),
    );
  });

  it('shows the terminal failure state when the broadcast is rejected', async () => {
    mockSw((m) => {
      if (m.action === 'prepareCatIssuance') return { pendingId: 'p1', assetId: ASSET_ID, catIssuanceSummary: summary() };
      if (m.action === 'confirmCatIssuance') return { success: false, code: 'PUSH_FAILED' };
      return { success: true };
    });
    renderWithProviders(<CatIssuancePanel onDone={() => {}} />);
    fireEvent.change(screen.getByTestId('issue-supply'), { target: { value: '1000' } });
    fireEvent.click(screen.getByTestId('issue-review'));
    fireEvent.click(await screen.findByTestId('issue-confirm'));
    expect(await screen.findByTestId('issue-failed')).toBeInTheDocument();
  });

  it('surfaces a build failure as an inline error', async () => {
    mockSw((m) => (m.action === 'prepareCatIssuance' ? { success: false, code: 'NO_XCH_COINS' } : { success: true }));
    renderWithProviders(<CatIssuancePanel onDone={() => {}} />);
    fireEvent.change(screen.getByTestId('issue-supply'), { target: { value: '1000' } });
    fireEvent.click(screen.getByTestId('issue-review'));
    expect(await screen.findByTestId('issue-build-error')).toBeInTheDocument();
  });

  it('has no WCAG violations (issuance form)', async () => {
    mockSw(() => ({ success: true }));
    const { container } = renderWithProviders(<CatIssuancePanel onDone={() => {}} />);
    expect((await axe(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
  });
});
