import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '@/test/harness';
import { TradePanel } from '@/features/wallet/custody/TradePanel';
import { custodyAssetBalances } from '@/features/wallet/custody/balances';
import { DIG_ASSET_ID } from '#shared/links.mjs';

/** XCH + $DIG assets so the give/get pickers have two distinct legs. */
function twoAssets() {
  return custodyAssetBalances({ xch: 1_000_000_000_000, cats: { [DIG_ASSET_ID]: 5000 } }, []);
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

const OFFER = 'offer1qqqexampleofferstringqqq';
const SUMMARY = {
  offered: [{ asset: { kind: 'xch' as const }, amount: '100000000000' }],
  requested: [{ asset: { kind: 'cat' as const, assetId: DIG_ASSET_ID }, amount: '250', toPuzzleHashHex: 'ab' }],
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('TradePanel — make', () => {
  it('builds an offer and shows the shareable deal card', async () => {
    mockSw((m) => {
      if (m.action === 'makeOffer') return { offer: OFFER, offerSummary: SUMMARY };
      return { success: true };
    });
    renderWithProviders(<TradePanel assets={twoAssets()} />);

    fireEvent.change(screen.getByTestId('trade-give-amount'), { target: { value: '0.1' } });
    fireEvent.change(screen.getByTestId('trade-get-amount'), { target: { value: '250' } });
    fireEvent.click(screen.getByTestId('trade-make-submit'));

    expect(await screen.findByTestId('trade-deal-card')).toBeInTheDocument();
    expect(screen.getByTestId('trade-offer-string')).toHaveValue(OFFER);
    // A QR renders for a short offer string.
    expect(screen.getByTestId('trade-qr')).toBeInTheDocument();
  });

  it('rejects trading an asset for itself', async () => {
    mockSw(() => ({ success: true }));
    renderWithProviders(<TradePanel assets={twoAssets()} />);
    // Force both pickers to the same asset (index 0).
    fireEvent.change(screen.getByTestId('trade-get-asset'), { target: { value: '0' } });
    fireEvent.change(screen.getByTestId('trade-give-amount'), { target: { value: '1' } });
    fireEvent.change(screen.getByTestId('trade-get-amount'), { target: { value: '1' } });
    fireEvent.click(screen.getByTestId('trade-make-submit'));
    expect(await screen.findByTestId('trade-make-error')).toBeInTheDocument();
  });
});

describe('TradePanel — take', () => {
  it('paste → review → accept → confirm → sending → confirmed (with polling)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockSw((m) => {
      if (m.action === 'inspectOffer') return { offerSummary: SUMMARY };
      if (m.action === 'prepareTrade') return { pendingId: 'p1', offerSummary: SUMMARY };
      if (m.action === 'confirmTrade') return { spentCoinId: 'coin1' };
      if (m.action === 'sendStatus') return { confirmed: true };
      return { success: true };
    });
    renderWithProviders(<TradePanel assets={twoAssets()} pollMs={50} />);

    fireEvent.click(screen.getByTestId('trade-mode-take'));
    fireEvent.change(screen.getByTestId('trade-take-input'), { target: { value: OFFER } });
    fireEvent.click(screen.getByTestId('trade-take-review-btn'));

    expect(await screen.findByTestId('trade-take-review')).toBeInTheDocument();
    expect(screen.getByTestId('trade-summary-get')).toHaveTextContent('XCH');

    fireEvent.click(screen.getByTestId('trade-take-accept'));
    expect(await screen.findByTestId('trade-take-confirm')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('trade-take-confirm'));

    expect(await screen.findByTestId('trade-sending')).toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(60);
    expect(await screen.findByTestId('trade-confirmed')).toBeInTheDocument();
  });

  it('rejects a non-offer string', async () => {
    mockSw(() => ({ success: true }));
    renderWithProviders(<TradePanel assets={twoAssets()} />);
    fireEvent.click(screen.getByTestId('trade-mode-take'));
    fireEvent.change(screen.getByTestId('trade-take-input'), { target: { value: 'not-an-offer' } });
    fireEvent.click(screen.getByTestId('trade-take-review-btn'));
    expect(await screen.findByTestId('trade-take-error')).toBeInTheDocument();
  });

  it('surfaces a failed broadcast', async () => {
    mockSw((m) => {
      if (m.action === 'inspectOffer') return { offerSummary: SUMMARY };
      if (m.action === 'prepareTrade') return { pendingId: 'p1', offerSummary: SUMMARY };
      if (m.action === 'confirmTrade') return { success: false, code: 'PUSH_FAILED' };
      return { success: true };
    });
    renderWithProviders(<TradePanel assets={twoAssets()} />);
    fireEvent.click(screen.getByTestId('trade-mode-take'));
    fireEvent.change(screen.getByTestId('trade-take-input'), { target: { value: OFFER } });
    fireEvent.click(screen.getByTestId('trade-take-review-btn'));
    fireEvent.click(await screen.findByTestId('trade-take-accept'));
    fireEvent.click(await screen.findByTestId('trade-take-confirm'));
    expect(await screen.findByTestId('trade-failed')).toBeInTheDocument();
  });
});
