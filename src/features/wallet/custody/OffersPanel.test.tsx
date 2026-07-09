import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/harness';
import { OffersPanel } from '@/features/wallet/custody/OffersPanel';
import type { OfferLogEntry } from '@/lib/offer-log';

function mockSw(router: (m: { action: string; [k: string]: unknown }) => unknown) {
  const fn = vi.fn((msg: unknown, cb?: (r: unknown) => void) => {
    const reply = router(msg as { action: string; [k: string]: unknown });
    if (cb) cb(reply);
    return Promise.resolve(reply);
  });
  (chrome.runtime as unknown as { sendMessage: typeof fn }).sendMessage = fn;
  return fn;
}

function offerEntry(over: Partial<OfferLogEntry> = {}): OfferLogEntry {
  return {
    id: over.id ?? 'offer:coin1',
    offer: over.offer ?? 'offer1qqqmadeqqq',
    summary: over.summary ?? {
      offered: [{ asset: { kind: 'xch' }, amount: '100000000000' }],
      requested: [{ asset: { kind: 'cat', assetId: 'aa'.repeat(32) }, amount: '250', toPuzzleHashHex: 'ab' }],
    },
    coinIdHex: over.coinIdHex ?? 'coin1',
    createdAt: over.createdAt ?? 1700000000000,
    status: over.status ?? 'open',
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('OffersPanel (#101 — saved/active offer management)', () => {
  it('renders a loading state, then the list', async () => {
    mockSw((m) => (m.action === 'getOffers' ? { offers: [offerEntry()] } : { success: true }));
    renderWithProviders(<OffersPanel full />);
    expect(await screen.findByTestId('offer-row-offer:coin1')).toBeInTheDocument();
  });

  it('shows a real empty-state when the wallet has made no offers', async () => {
    mockSw((m) => (m.action === 'getOffers' ? { offers: [] } : { success: true }));
    renderWithProviders(<OffersPanel full />);
    expect(await screen.findByTestId('offers-empty')).toBeInTheDocument();
  });

  it('shows a recoverable error state with retry on a failed fetch', async () => {
    let calls = 0;
    mockSw((m) => {
      if (m.action === 'getOffers') {
        calls++;
        return calls === 1 ? { success: false, code: 'CUSTODY_ERROR' } : { offers: [offerEntry()] };
      }
      return { success: true };
    });
    renderWithProviders(<OffersPanel full />);
    expect(await screen.findByTestId('offers-error')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('offers-retry'));
    expect(await screen.findByTestId('offer-row-offer:coin1')).toBeInTheDocument();
  });

  it('shows the status badge for each offer', async () => {
    mockSw((m) => (m.action === 'getOffers' ? { offers: [offerEntry({ id: 'a', status: 'open' }), offerEntry({ id: 'b', coinIdHex: 'c2', status: 'taken' })] } : { success: true }));
    renderWithProviders(<OffersPanel full />);
    await screen.findByTestId('offer-row-a');
    expect(screen.getByTestId('offer-status-a')).toHaveAttribute('data-status', 'open');
    expect(screen.getByTestId('offer-status-b')).toHaveAttribute('data-status', 'taken');
  });

  it('fullscreen: shows copy + cancel actions for an OPEN offer', async () => {
    mockSw((m) => (m.action === 'getOffers' ? { offers: [offerEntry()] } : { success: true }));
    renderWithProviders(<OffersPanel full />);
    await screen.findByTestId('offer-row-offer:coin1');
    expect(screen.getByTestId('offer-copy-offer:coin1')).toBeInTheDocument();
    expect(screen.getByTestId('offer-cancel-offer:coin1')).toBeInTheDocument();
  });

  it('fullscreen: a TAKEN offer has no cancel action', async () => {
    mockSw((m) => (m.action === 'getOffers' ? { offers: [offerEntry({ status: 'taken' })] } : { success: true }));
    renderWithProviders(<OffersPanel full />);
    await screen.findByTestId('offer-row-offer:coin1');
    expect(screen.queryByTestId('offer-cancel-offer:coin1')).not.toBeInTheDocument();
  });

  it('popup (view-only): renders the list with status but NO copy/cancel actions', async () => {
    mockSw((m) => (m.action === 'getOffers' ? { offers: [offerEntry()] } : { success: true }));
    renderWithProviders(<OffersPanel full={false} />);
    await screen.findByTestId('offer-row-offer:coin1');
    expect(screen.getByTestId('offer-status-offer:coin1')).toBeInTheDocument();
    expect(screen.queryByTestId('offer-copy-offer:coin1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('offer-cancel-offer:coin1')).not.toBeInTheDocument();
  });

  it('cancels an open offer end-to-end (prepareTrade cancel → confirmTrade)', async () => {
    mockSw((m) => {
      if (m.action === 'getOffers') return { offers: [offerEntry()] };
      if (m.action === 'prepareTrade') return { pendingId: 'p1', offerSummary: offerEntry().summary };
      if (m.action === 'confirmTrade') return { spentCoinId: 'coin1', tradeKind: 'cancel' };
      return { success: true };
    });
    renderWithProviders(<OffersPanel full />);
    await screen.findByTestId('offer-row-offer:coin1');
    fireEvent.click(screen.getByTestId('offer-cancel-offer:coin1'));
    expect(await screen.findByTestId('offer-cancelled-offer:coin1')).toBeInTheDocument();
  });

  it('surfaces a failed cancel', async () => {
    mockSw((m) => {
      if (m.action === 'getOffers') return { offers: [offerEntry()] };
      if (m.action === 'prepareTrade') return { pendingId: 'p1', offerSummary: offerEntry().summary };
      if (m.action === 'confirmTrade') return { success: false, code: 'PUSH_FAILED' };
      return { success: true };
    });
    renderWithProviders(<OffersPanel full />);
    await screen.findByTestId('offer-row-offer:coin1');
    fireEvent.click(screen.getByTestId('offer-cancel-offer:coin1'));
    expect(await screen.findByTestId('offer-cancel-failed-offer:coin1')).toBeInTheDocument();
  });

  it('copies the offer string to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    mockSw((m) => (m.action === 'getOffers' ? { offers: [offerEntry()] } : { success: true }));
    renderWithProviders(<OffersPanel full />);
    await screen.findByTestId('offer-row-offer:coin1');
    fireEvent.click(screen.getByTestId('offer-copy-offer:coin1'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('offer1qqqmadeqqq'));
  });
});
