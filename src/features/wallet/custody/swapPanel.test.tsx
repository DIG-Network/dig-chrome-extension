import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { axe } from 'jest-axe';
import { renderWithProviders } from '@/test/harness';
import { SwapPanel } from '@/features/wallet/custody/SwapPanel';
import type { AssetBalance } from '@/features/wallet/assetTypes';
import type { WireOfferSummary } from '@/offscreen/vault';
import type { DexieOfferSummary } from '@/lib/dexie';

// XCH balance covers the largest fixture offer (10 XCH) with headroom, so tests can type a valid,
// affordable amount and still reach an existing dexie offer (#484 — the amount now GATES which
// offer is selectable, so the wallet must actually be able to afford whatever offer a test drives
// through to review/confirm).
const XCH: AssetBalance = { descriptor: { key: 'xch', ticker: 'XCH', name: 'Chia', decimals: 12, iconUrl: null, assetId: null, type: null }, balance: 20_000_000_000_000, label: '20' };
const DBX: AssetBalance = { descriptor: { key: 'cat', ticker: 'DBX', name: 'Dexie Bucks', decimals: 3, iconUrl: null, assetId: 'aa'.repeat(32), type: 'cat' }, balance: 100_000, label: '100' };

/** Type a valid amount into the swap amount field (#484) — the default fixture offer needs 10 XCH. */
function fillAmount(value = '10') {
  fireEvent.change(screen.getByTestId('swap-amount'), { target: { value } });
}

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
    await screen.findByTestId('swap-quote-result');
    fillAmount();
    fireEvent.click(screen.getByTestId('swap-review'));
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
    await screen.findByTestId('swap-quote-result');
    fillAmount();
    fireEvent.click(screen.getByTestId('swap-review'));
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
    await screen.findByTestId('swap-quote-result');
    fillAmount();
    fireEvent.click(screen.getByTestId('swap-review'));
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
    await screen.findByTestId('swap-quote-result');
    fillAmount();
    fireEvent.click(screen.getByTestId('swap-review'));
    await waitFor(() => expect(screen.getByTestId('swap-build-error')).toBeInTheDocument());
  });

  it('has no WCAG violations (swap picker)', async () => {
    mockSw((m) => (m.action === 'dexieBrowse' ? { offers: [dexieOffer()] } : { success: true }));
    const { container } = renderWithProviders(<SwapPanel assets={[XCH, DBX]} onDone={() => {}} />);
    await screen.findByTestId('swap-quote-result');
    expect((await axe(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
  });

  // ── #484 — amount-to-swap input ──────────────────────────────────────────────────────────────

  it('disables the review/submit button until a valid amount is entered', async () => {
    mockSw((m) => (m.action === 'dexieBrowse' ? { offers: [dexieOffer()] } : { success: true }));
    renderWithProviders(<SwapPanel assets={[XCH, DBX]} onDone={() => {}} />);
    await screen.findByTestId('swap-quote-result');
    expect(screen.getByTestId('swap-review')).toBeDisabled();
    fillAmount('10');
    await waitFor(() => expect(screen.getByTestId('swap-review')).not.toBeDisabled());
  });

  it('shows an inline error and keeps submit disabled for a zero amount', async () => {
    mockSw((m) => (m.action === 'dexieBrowse' ? { offers: [dexieOffer()] } : { success: true }));
    renderWithProviders(<SwapPanel assets={[XCH, DBX]} onDone={() => {}} />);
    await screen.findByTestId('swap-quote-result');
    fillAmount('0');
    expect(await screen.findByTestId('swap-amount-error')).toHaveTextContent(/positive amount/i);
    expect(screen.getByTestId('swap-review')).toBeDisabled();
  });

  it('shows an inline error and keeps submit disabled for a negative amount', async () => {
    mockSw((m) => (m.action === 'dexieBrowse' ? { offers: [dexieOffer()] } : { success: true }));
    renderWithProviders(<SwapPanel assets={[XCH, DBX]} onDone={() => {}} />);
    await screen.findByTestId('swap-quote-result');
    fillAmount('-3');
    expect(await screen.findByTestId('swap-amount-error')).toHaveTextContent(/positive amount/i);
    expect(screen.getByTestId('swap-review')).toBeDisabled();
  });

  it('shows an inline error and keeps submit disabled for an amount over the wallet balance', async () => {
    mockSw((m) => (m.action === 'dexieBrowse' ? { offers: [dexieOffer()] } : { success: true }));
    renderWithProviders(<SwapPanel assets={[XCH, DBX]} onDone={() => {}} />);
    await screen.findByTestId('swap-quote-result');
    fillAmount('25'); // wallet only holds 20 XCH
    expect(await screen.findByTestId('swap-amount-error')).toHaveTextContent(/enough/i);
    expect(screen.getByTestId('swap-review')).toBeDisabled();
  });

  it('shows an inline error for more decimal places than the asset supports', async () => {
    mockSw((m) => (m.action === 'dexieBrowse' ? { offers: [dexieOffer()] } : { success: true }));
    renderWithProviders(<SwapPanel assets={[XCH, DBX]} onDone={() => {}} />);
    await screen.findByTestId('swap-quote-result');
    // 13 fractional digits > XCH's 12 decimals; kept >= 10 so the fixture offer still fits the
    // ceiling (the review button stays rendered — just disabled — so the precision error is
    // isolated from the "no offer fits this amount" empty-state branch tested separately below).
    fillAmount('10.1234567890123');
    expect(await screen.findByTestId('swap-amount-error')).toHaveTextContent(/decimal/i);
    expect(screen.getByTestId('swap-review')).toBeDisabled();
  });

  it('the Max button fills the full spendable balance of the pay asset', async () => {
    mockSw((m) => (m.action === 'dexieBrowse' ? { offers: [dexieOffer()] } : { success: true }));
    renderWithProviders(<SwapPanel assets={[XCH, DBX]} onDone={() => {}} />);
    await screen.findByTestId('swap-quote-result');
    fireEvent.click(screen.getByTestId('swap-amount-max'));
    expect(screen.getByTestId('swap-amount')).toHaveValue('20');
  });

  it('resets the amount when the pay asset changes (decimals/balance differ)', async () => {
    mockSw((m) => (m.action === 'dexieBrowse' ? { offers: [dexieOffer()] } : { success: true }));
    renderWithProviders(<SwapPanel assets={[XCH, DBX]} onDone={() => {}} />);
    await screen.findByTestId('swap-quote-result');
    fillAmount('10');
    expect(screen.getByTestId('swap-amount')).toHaveValue('10');
    fireEvent.change(screen.getByTestId('swap-pay-asset'), { target: { value: '1' } });
    expect(screen.getByTestId('swap-amount')).toHaveValue('');
  });

  it('shows the balance hint for the currently-selected pay asset', async () => {
    mockSw((m) => (m.action === 'dexieBrowse' ? { offers: [dexieOffer()] } : { success: true }));
    renderWithProviders(<SwapPanel assets={[XCH, DBX]} onDone={() => {}} />);
    await screen.findByTestId('swap-quote-result');
    expect(screen.getByTestId('swap-amount-balance')).toHaveTextContent('20 XCH');
  });

  it('the entered amount steers WHICH offer is selected (and taken) — not just the best rate', async () => {
    // "rich" needs 10 XCH at the best rate (100 DBX/XCH); "affordable" needs only 3 XCH at a worse
    // rate (50 DBX/XCH). With no amount typed, the unconstrained best-rate pick is "rich". Typing an
    // amount of 3 must exclude "rich" (too big) and select "affordable" instead — proving the amount
    // actually drives which offer's bytes reach `prepareTrade`, not a hardcoded/global best pick.
    const rich = dexieOffer({ id: 'rich', offerStr: 'offer1rich', offered: [{ id: 'aa'.repeat(32), code: 'DBX', amount: 1000 }], requested: [{ id: 'xch', code: 'XCH', amount: 10 }] });
    const affordable = dexieOffer({ id: 'affordable', offerStr: 'offer1affordable', offered: [{ id: 'aa'.repeat(32), code: 'DBX', amount: 150 }], requested: [{ id: 'xch', code: 'XCH', amount: 3 }] });
    const sw = mockSw((m) => {
      if (m.action === 'dexieBrowse') return { offers: [rich, affordable] };
      if (m.action === 'prepareTrade') return { pendingId: 'p1', offerSummary: offerSummary() };
      return { success: true };
    });
    renderWithProviders(<SwapPanel assets={[XCH, DBX]} onDone={() => {}} />);

    // Unconstrained default: best rate wins ("rich", 10 XCH / 1000 DBX).
    await screen.findByTestId('swap-quote-result');
    expect(screen.getByTestId('swap-quote-pay')).toHaveTextContent('10 XCH');

    // Typing an affordable ceiling re-selects the smaller offer the ceiling actually fits.
    fillAmount('3');
    await waitFor(() => expect(screen.getByTestId('swap-quote-pay')).toHaveTextContent('3 XCH'));
    expect(screen.getByTestId('swap-quote-receive')).toHaveTextContent('150 DBX');

    fireEvent.click(screen.getByTestId('swap-review'));
    await screen.findByTestId('swap-review-panel');
    expect(sw).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'prepareTrade', offerStr: 'offer1affordable', tradeKind: 'take' }),
      expect.any(Function),
    );
  });

  it('shows the no-match empty state when no open offer fits the entered amount', async () => {
    // Only "rich" (10 XCH) is open; typing a 2-XCH ceiling can't fit it — no quote, empty state.
    mockSw((m) => (m.action === 'dexieBrowse' ? { offers: [dexieOffer()] } : { success: true }));
    renderWithProviders(<SwapPanel assets={[XCH, DBX]} onDone={() => {}} />);
    await screen.findByTestId('swap-quote-result');
    fillAmount('2');
    expect(await screen.findByTestId('swap-quote-empty')).toBeInTheDocument();
  });

  it('has no WCAG violations with the amount field populated + an inline error shown', async () => {
    mockSw((m) => (m.action === 'dexieBrowse' ? { offers: [dexieOffer()] } : { success: true }));
    const { container } = renderWithProviders(<SwapPanel assets={[XCH, DBX]} onDone={() => {}} />);
    await screen.findByTestId('swap-quote-result');
    fillAmount('0');
    await screen.findByTestId('swap-amount-error');
    expect((await axe(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
  });
});
