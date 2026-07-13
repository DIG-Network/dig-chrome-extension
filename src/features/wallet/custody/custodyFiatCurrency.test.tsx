import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/harness';
import { CustodyWallet } from '@/features/wallet/custody/CustodyWallet';
import { COINGECKO_XCH_URL, DEXIE_TICKERS_URL } from '@/features/wallet/priceSources';
import { COINGECKO_FX_URL } from '@/features/wallet/fxRates';
import { FIAT_CURRENCY_STORAGE_KEY } from '@/features/wallet/fiatCurrency';
import { DIG_ASSET_ID } from '@/lib/links';

/**
 * #112 — the fiat-currency preference end to end: picking a currency reformats the portfolio total
 * AND every per-asset fiat line, persists across a remount, and shows a loading indicator (never
 * "unavailable") while the exchange rate is in flight (#158).
 */
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

/** A `chrome.storage.local` mock that actually persists across get/set (so the currency preference
 * round-trips, mirroring `homeScreen.test.tsx`'s balance-unit persistence proof). */
function mockStorage(seed: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = { ...seed };
  (chrome as unknown as { storage: unknown }).storage = {
    local: {
      get: vi.fn(async (key: string) => (key in store ? { [key]: store[key] } : {})),
      set: vi.fn(async (items: Record<string, unknown>) => {
        Object.assign(store, items);
      }),
      remove: vi.fn(async (key: string) => {
        delete store[key];
      }),
    },
    onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
  };
  return store;
}

let resolveFx: (() => void) | null = null;

function mockMarket() {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL) => {
    const url = String(input);
    if (url === COINGECKO_XCH_URL) {
      return Promise.resolve({ ok: true, json: async () => ({ chia: { usd: 10, usd_24h_change: null } }) } as Response);
    }
    if (url === DEXIE_TICKERS_URL) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ tickers: [{ base_id: DIG_ASSET_ID, target_id: 'xch', last_price: '0.05' }] }),
      } as Response);
    }
    if (url === COINGECKO_FX_URL) {
      return new Promise((resolve) => {
        resolveFx = () => resolve({ ok: true, json: async () => ({ chia: { usd: 10, eur: 9 } }) } as Response);
      });
    }
    return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
  });
}

beforeEach(async () => {
  resolveFx = null;
  mockSw();
});
afterEach(() => vi.restoreAllMocks());

describe('CustodyWallet — fiat currency preference (#112)', () => {
  it('defaults to USD with no exchange-rate fetch', async () => {
    mockStorage();
    mockMarket();
    renderWithProviders(<CustodyWallet />);
    await waitFor(() => expect(screen.getByTestId('portfolio-value')).toHaveTextContent('$25.00'));
    expect(resolveFx).toBeNull(); // the fx endpoint was never even queried
  });

  it('picking a currency shows a loading indicator, then reformats every $ value once the rate resolves', async () => {
    mockStorage();
    mockMarket();
    renderWithProviders(<CustodyWallet />);
    await waitFor(() => expect(screen.getByTestId('portfolio-value')).toHaveTextContent('$25.00'));

    fireEvent.change(screen.getByTestId('fiat-currency-select'), { target: { value: 'eur' } });

    // The rate fetch is deliberately held open: the total must show a loading skeleton, never the
    // "unavailable" text, and the per-asset lines keep their last-known USD figures (unaffected by
    // the in-flight fx fetch, since only the TOTAL currency changed so far).
    expect(await screen.findByTestId('portfolio-value-loading')).toBeInTheDocument();
    expect(screen.getByTestId('portfolio-value')).not.toHaveTextContent(/unavailable/i);

    resolveFx?.();

    // 2 XCH × $10 = $20 + 10 DIG × $0.50 = $5 → $25 usd × 0.9 eur/usd = €22.50.
    await waitFor(() => expect(screen.getByTestId('portfolio-value')).toHaveTextContent('€22.50'));
    expect(screen.getByTestId('asset-xch-fiat')).toHaveTextContent('€18.00'); // $20 × 0.9
    expect(screen.getByTestId('asset-dig-fiat')).toHaveTextContent('€4.50'); // $5 × 0.9
  });

  it('persists the chosen currency to storage, and a later mount reads it back', async () => {
    const store = mockStorage();
    mockMarket();
    const { unmount } = renderWithProviders(<CustodyWallet />);
    await waitFor(() => expect(screen.getByTestId('portfolio-value')).toHaveTextContent('$25.00'));

    fireEvent.change(screen.getByTestId('fiat-currency-select'), { target: { value: 'eur' } });
    await waitFor(() => expect(store[FIAT_CURRENCY_STORAGE_KEY]).toBe('eur'));
    resolveFx?.();
    await waitFor(() => expect(screen.getByTestId('portfolio-value')).toHaveTextContent('€22.50'));
    unmount();

    mockMarket();
    renderWithProviders(<CustodyWallet />);
    // The persisted preference is read back asynchronously from `chrome.storage.local` (same
    // `useStorageValue` idiom as `home-balance-swap`'s round-trip proof).
    await waitFor(() => expect(screen.getByTestId('fiat-currency-select')).toHaveValue('eur'));
    resolveFx?.();
    await waitFor(() => expect(screen.getByTestId('portfolio-value')).toHaveTextContent('€22.50'));
  });
});
