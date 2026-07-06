import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/harness';
import { CustodyWallet } from '@/features/wallet/custody/CustodyWallet';
import { COINGECKO_XCH_URL, DEXIE_TICKERS_URL } from '@/features/wallet/priceSources';
import { DIG_ASSET_ID } from '@/lib/links';

/** Route the SW seam to a canned unlocked wallet holding 2 XCH + 10.000 $DIG. */
function mockSw() {
  const fn = vi.fn((msg: unknown, cb?: (r: unknown) => void) => {
    const action = (msg as { action?: string }).action;
    let reply: unknown = { success: true };
    if (action === 'getCustodyBalances') {
      reply = { balances: { xch: 2_000_000_000_000, cats: { [DIG_ASSET_ID]: 10_000 } } };
    } else if (action === 'getReceiveAddress') {
      reply = { address: 'xch1receive' };
    }
    if (cb) cb(reply);
    return Promise.resolve(reply);
  });
  (chrome.runtime as unknown as { sendMessage: typeof fn }).sendMessage = fn;
}

/** Mock the two price sources: XCH $10 (down 5%), $DIG 0.05 XCH → $0.50. */
function mockPrices(fail = false) {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL) => {
    if (fail) return Promise.reject(new Error('offline'));
    const url = String(input);
    const body =
      url === COINGECKO_XCH_URL
        ? { chia: { usd: 10, usd_24h_change: -5 } }
        : url === DEXIE_TICKERS_URL
          ? { tickers: [{ base_id: DIG_ASSET_ID, target_id: 'xch', last_price: '0.05' }] }
          : {};
    return Promise.resolve({ ok: true, json: async () => body } as Response);
  });
}

beforeEach(async () => {
  await chrome.storage.local.remove('wallet.watchedCats');
  mockSw();
});
afterEach(() => vi.restoreAllMocks());

describe('CustodyWallet — fiat prices (#86)', () => {
  it('shows the total portfolio fiat value, a 24h delta, and per-asset fiat', async () => {
    mockPrices();
    renderWithProviders(<CustodyWallet />);

    // Total: 2 XCH × $10 = $20 + 10 $DIG × $0.50 = $5 → $25.00.
    await waitFor(() => expect(screen.getByTestId('portfolio-value')).toHaveTextContent('$25.00'));

    // 24h delta chip present, marked down (only XCH carries a change → -5%).
    const change = await screen.findByTestId('portfolio-change');
    expect(change).toHaveAttribute('data-direction', 'down');
    expect(change).toHaveTextContent('5.00%');

    // Per-asset fiat: XCH row ≈ $20.00, $DIG row ≈ $5.00.
    expect(screen.getByTestId('asset-xch-fiat')).toHaveTextContent('$20.00');
    expect(screen.getByTestId('asset-dig-fiat')).toHaveTextContent('$5.00');
  });

  it('falls back to the native balance + "value unavailable" when prices fail (never blocks)', async () => {
    mockPrices(true);
    renderWithProviders(<CustodyWallet />);

    // Balances still render (2 XCH), and the header shows the honest unavailable status.
    await waitFor(() => expect(screen.getByTestId('portfolio-value')).toHaveTextContent('2'));
    expect(await screen.findByTestId('portfolio-status')).toBeInTheDocument();
    expect(screen.queryByTestId('portfolio-change')).not.toBeInTheDocument();
    // Per-asset fiat shows the unavailable line, not a fabricated value.
    expect(screen.getByTestId('asset-xch-fiat')).toHaveTextContent('$—');
  });
});
