import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { axe } from 'jest-axe';
import { renderWithProviders } from '@/test/harness';
import { SwapPanel } from '@/features/wallet/custody/SwapPanel';
import type { AssetBalance } from '@/features/wallet/assetTypes';
import type { WireOfferSummary } from '@/offscreen/vault';
import type { DexieOfferSummary } from '@/lib/dexie';

const XCH: AssetBalance = { descriptor: { key: 'xch', ticker: 'XCH', name: 'Chia', decimals: 12, iconUrl: null, assetId: null, type: null }, balance: 5_000_000_000_000, label: '5' };
const DBX: AssetBalance = { descriptor: { key: 'cat', ticker: 'DBX', name: 'Dexie Bucks', decimals: 3, iconUrl: null, assetId: 'aa'.repeat(32), type: 'cat' }, balance: 100_000, label: '100' };

// Default wallet UI state is "pay XCH → receive DBX" (sellIdx=0/buyIdx=1), so a matching dexie offer
// must OFFER DBX and REQUEST XCH (the counterparty gives DBX for XCH).
function dexieOffer(over: Partial<DexieOfferSummary> = {}): DexieOfferSummary {
  return {
    id: 'o1',
    offerStr: 'offer1qqqswapexampleqqq',
    status: 0,
    dateFound: '2026-01-01T00:00:00Z',
    offered: [{ id: 'aa'.repeat(32), code: 'DBX', amount: 1000 }],
    requested: [{ id: 'xch', code: 'XCH', amount: 10 }],
    ...over,
  };
}

function offerSummary(): WireOfferSummary {
  return {
    offered: [{ asset: { kind: 'xch' }, amount: '10000000000000' }],
    requested: [{ asset: { kind: 'cat', assetId: 'aa'.repeat(32) }, amount: '1000000', toPuzzleHashHex: 'ab' }],
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

describe('SwapPanel', () => {
  it('shows a needs-asset message with only one wallet asset', () => {
    mockSw(() => ({ success: true }));
    renderWithProviders(<SwapPanel assets={[XCH]} onDone={() => {}} />);
    expect(screen.getByTestId('swap-needs-asset')).toBeInTheDocument();
  });

  it('shows a same-asset error when pay/receive match', async () => {
    mockSw(() => ({ success: true }));
    renderWithProviders(<SwapPanel assets={[XCH, DBX]} onDone={() => {}} />);
    fireEvent.change(screen.getByTestId('swap-receive-asset'), { target: { value: '0' } });
    expect(await screen.findByTestId('swap-same-asset-error')).toBeInTheDocument();
  });

  it('fetches a quote and shows the best-rate offer', async () => {
    mockSw((m) => (m.action === 'dexieBrowse' ? { offers: [dexieOffer()] } : { success: true }));
    renderWithProviders(<SwapPanel assets={[XCH, DBX]} onDone={() => {}} />);
    expect(await screen.findByTestId('swap-quote-result')).toBeInTheDocument();
    expect(screen.getByTestId('swap-quote-pay')).toHaveTextContent('10 XCH');
    expect(screen.getByTestId('swap-quote-receive')).toHaveTextContent('1000 DBX');
  });

  it('shows the empty state when no matching offer exists', async () => {
    mockSw((m) => (m.action === 'dexieBrowse' ? { offers: [] } : { success: true }));
    renderWithProviders(<SwapPanel assets={[XCH, DBX]} onDone={() => {}} />);
    expect(await screen.findByTestId('swap-quote-empty')).toBeInTheDocument();
  });

  it('quote → review shows the DECODED (re-derived) summary, not the dexie display numbers', async () => {
    mockSw((m) => {
      if (m.action === 'dexieBrowse') return { offers: [dexieOffer()] };
      if (m.action === 'prepareTrade') return { pendingId: 'p1', offerSummary: offerSummary() };
      return { success: true };
    });
    renderWithProviders(<SwapPanel assets={[XCH, DBX]} onDone={() => {}} />);
    fireEvent.click(await screen.findByTestId('swap-review'));
    expect(await screen.findByTestId('swap-review-panel')).toBeInTheDocument();
    expect(screen.getByTestId('swap-review-receive')).toHaveTextContent('XCH');
  });

  it('review → confirm → sending → confirmed (happy path with polling)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const sw = mockSw((m) => {
      if (m.action === 'dexieBrowse') return { offers: [dexieOffer()] };
      if (m.action === 'prepareTrade') return { pendingId: 'p1', offerSummary: offerSummary() };
      if (m.action === 'confirmTrade') return { spentCoinId: 'coin1' };
      if (m.action === 'sendStatus') return { confirmed: true };
      return { success: true };
    });
    renderWithProviders(<SwapPanel assets={[XCH, DBX]} onDone={() => {}} pollMs={50} />);
    fireEvent.click(await screen.findByTestId('swap-review'));
    fireEvent.click(await screen.findByTestId('swap-confirm'));

    expect(await screen.findByTestId('swap-sending')).toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(60);
    expect(await screen.findByTestId('swap-confirmed')).toBeInTheDocument();
    expect(sw).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'prepareTrade', offerStr: 'offer1qqqswapexampleqqq', tradeKind: 'take' }),
      expect.any(Function),
    );
  });

  it('shows the terminal failure state when the broadcast is rejected', async () => {
    mockSw((m) => {
      if (m.action === 'dexieBrowse') return { offers: [dexieOffer()] };
      if (m.action === 'prepareTrade') return { pendingId: 'p1', offerSummary: offerSummary() };
      if (m.action === 'confirmTrade') return { success: false, code: 'PUSH_FAILED' };
      return { success: true };
    });
    renderWithProviders(<SwapPanel assets={[XCH, DBX]} onDone={() => {}} />);
    fireEvent.click(await screen.findByTestId('swap-review'));
    fireEvent.click(await screen.findByTestId('swap-confirm'));
    expect(await screen.findByTestId('swap-failed')).toBeInTheDocument();
  });

  it('surfaces a build failure as an inline error', async () => {
    mockSw((m) => {
      if (m.action === 'dexieBrowse') return { offers: [dexieOffer()] };
      if (m.action === 'prepareTrade') return { success: false, code: 'NO_XCH_COINS' };
      return { success: true };
    });
    renderWithProviders(<SwapPanel assets={[XCH, DBX]} onDone={() => {}} />);
    fireEvent.click(await screen.findByTestId('swap-review'));
    await waitFor(() => expect(screen.getByTestId('swap-build-error')).toBeInTheDocument());
  });

  it('has no WCAG violations (swap picker)', async () => {
    mockSw((m) => (m.action === 'dexieBrowse' ? { offers: [dexieOffer()] } : { success: true }));
    const { container } = renderWithProviders(<SwapPanel assets={[XCH, DBX]} onDone={() => {}} />);
    await screen.findByTestId('swap-quote-result');
    expect((await axe(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
  });
});
