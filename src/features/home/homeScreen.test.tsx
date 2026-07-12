import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/harness';
import { createStore } from '@/app/store';
import { HomeScreen } from '@/features/home/HomeScreen';
import { BALANCE_UNIT_STORAGE_KEY } from '@/features/wallet/balanceUnit';
import { FIAT_CURRENCY_STORAGE_KEY } from '@/features/wallet/fiatCurrency';
import { COINGECKO_FX_URL } from '@/features/wallet/fxRates';

const CATALOG = { apps: [{ slug: 'chia-offer', name: 'Chia-Offer', icon: 'https://explore.dig.net/catalog/chia-offer/icon-512.png', link: 'https://chia-offer.on.dig.net/', category: 'tools', featured: true }] };

/** CoinGecko + dexie responses for a deterministic XCH price ($10, no CATs held here). */
const XCH_PRICE_JSON = { chia: { usd: 10, usd_24h_change: -5 } };
const DEXIE_JSON = { tickers: [] };

function mockSw(unlocked = true) {
  (chrome.runtime as unknown as { sendMessage: unknown }).sendMessage = vi.fn((msg: { action?: string } | undefined, cb?: (r: unknown) => void) => {
    let reply: unknown = { success: true };
    if (msg?.action === 'getLockState') reply = { lockState: unlocked ? 'unlocked' : 'locked' };
    else if (msg?.action === 'getCustodyBalances') reply = { balances: { xch: 2_510_000_000_000, cats: {} } };
    else if (msg?.action === 'getActivity') reply = { events: [] };
    else if (msg?.action === 'getDigNodeStatus') reply = { reachable: false, base: null };
    if (cb) cb(reply);
    return Promise.resolve(reply);
  });
}

/** A `chrome.storage.local` mock that actually persists across `get`/`set` calls (unlike a stub
 *  that always resolves `{}`), so the display-unit preference can be proven to round-trip (#156). */
function mockStorage(seed: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = { ...seed };
  (chrome as unknown as { storage: unknown }).storage = {
    local: {
      get: vi.fn(async (key: string) => (key in store ? { [key]: store[key] } : {})),
      set: vi.fn(async (items: Record<string, unknown>) => {
        Object.assign(store, items);
      }),
    },
    onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
  };
  return store;
}

/** Route fetches: the app-catalog URL gets the store JSON, price sources get deterministic quotes. */
function mockFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('coingecko')) return { ok: true, json: async () => XCH_PRICE_JSON };
      if (u.includes('dexie')) return { ok: true, json: async () => DEXIE_JSON };
      return { ok: true, json: async () => CATALOG };
    }),
  );
}

beforeEach(() => {
  mockStorage();
  mockFetch();
  mockSw(true);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('HomeScreen (mobile-OS home)', () => {
  it('renders the balance widget, quick actions, status, open-by-URN input, and dApp launcher', async () => {
    renderWithProviders(<HomeScreen />);
    expect(screen.getByTestId('home-screen')).toBeInTheDocument();
    expect(screen.getByTestId('home-quickactions')).toBeInTheDocument();
    expect(screen.getByTestId('home-status')).toBeInTheDocument();
    expect(screen.getByTestId('home-openurn')).toBeInTheDocument();
    expect(await screen.findByTestId('home-balance-value')).toBeInTheDocument();
    expect(await screen.findByTestId('home-apps-grid')).toBeInTheDocument();
    expect(screen.getByTestId('app-tile-chia-offer')).toBeInTheDocument();
  });

  it('#306 — the DIG toolbar toggle no longer lives on the Home screen (it moved to the window header)', () => {
    renderWithProviders(<HomeScreen />);
    expect(screen.queryByTestId('home-toolbar-toggle-widget')).toBeNull();
  });

  it('#312 — the URN entry input is the TOP-most Home element (docked flush to the top edge)', () => {
    renderWithProviders(<HomeScreen />);
    const home = screen.getByTestId('home-screen');
    // The first child of the Home column is the flush URN input, before the widget board.
    expect(home.firstElementChild).toBe(screen.getByTestId('home-openurn'));
    expect(screen.getByTestId('home-openurn')).toHaveClass('dig-openurn--flush');
  });

  it('prompts to open the wallet when locked', async () => {
    mockSw(false);
    renderWithProviders(<HomeScreen />);
    expect(await screen.findByTestId('home-balance-locked')).toBeInTheDocument();
  });

  it('quick actions route to the wallet on the right sub-view', async () => {
    const store = createStore();
    renderWithProviders(<HomeScreen />, { store });
    fireEvent.click(screen.getByTestId('home-action-trade'));
    expect(store.getState().ui.tab).toBe('wallet');
    expect(store.getState().ui.walletView).toBe('trade');
  });

  it('the status node pill opens the Network screen', async () => {
    const store = createStore();
    renderWithProviders(<HomeScreen />, { store });
    fireEvent.click(await screen.findByTestId('home-status-node'));
    expect(store.getState().ui.tab).toBe('network');
  });

  it('see-all opens the Apps screen', () => {
    const store = createStore();
    renderWithProviders(<HomeScreen />, { store });
    fireEvent.click(screen.getByTestId('home-apps-seeall'));
    expect(store.getState().ui.tab).toBe('apps');
  });

  it('#151 the activity peek resolves a CAT to its REAL registry ticker, not "CAT"', async () => {
    const tail = 'c'.repeat(64);
    (chrome.runtime as unknown as { sendMessage: unknown }).sendMessage = vi.fn(
      (msg: { action?: string } | undefined, cb?: (r: unknown) => void) => {
        let reply: unknown = { success: true };
        if (msg?.action === 'getLockState') reply = { lockState: 'unlocked' };
        else if (msg?.action === 'getCustodyBalances') reply = { balances: { xch: 0, cats: {} } };
        else if (msg?.action === 'getActivity') {
          reply = { events: [{ id: 'r:cat', kind: 'received', asset: tail, amount: '2500', counterparty: null, timestamp: 300, coinId: 'c'.repeat(64), status: 'confirmed' }] };
        } else if (msg?.action === 'getDigNodeStatus') reply = { reachable: false, base: null };
        if (cb) cb(reply);
        return Promise.resolve(reply);
      },
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes('coingecko')) return { ok: true, json: async () => XCH_PRICE_JSON };
        if (u.includes('dexie')) return { ok: true, json: async () => ({ success: true, tokens: [{ id: tail, name: 'Gamma Coin', code: 'GMA', denom: 1000 }] }) };
        return { ok: true, json: async () => CATALOG };
      }),
    );
    renderWithProviders(<HomeScreen />);
    expect(await screen.findByTestId('home-activity-r:cat')).toHaveTextContent('GMA');
  });
});

describe('HomeScreen balance-unit swap (#156)', () => {
  it('defaults to XCH prominent, with the USD equivalent shown small underneath', async () => {
    renderWithProviders(<HomeScreen />);
    // 2.51 XCH is the seeded custody balance; $10/XCH → $25.10 secondary.
    await waitFor(() => expect(screen.getByTestId('home-balance-value')).toHaveTextContent('2.51 XCH'));
    await waitFor(() => expect(screen.getByTestId('home-balance-secondary')).toHaveTextContent('$25.10'));
  });

  it('the swap button flips the prominent unit to USD, showing XCH as the secondary line', async () => {
    renderWithProviders(<HomeScreen />);
    await waitFor(() => expect(screen.getByTestId('home-balance-value')).toHaveTextContent('2.51 XCH'));

    fireEvent.click(screen.getByTestId('home-balance-swap'));

    await waitFor(() => expect(screen.getByTestId('home-balance-value')).toHaveTextContent('$25.10'));
    expect(screen.getByTestId('home-balance-secondary')).toHaveTextContent('2.51 XCH');
  });

  it('persists the chosen unit to storage, and a later mount reads it back (survives reopen)', async () => {
    const store = mockStorage();
    const { unmount } = renderWithProviders(<HomeScreen />);
    await waitFor(() => expect(screen.getByTestId('home-balance-value')).toHaveTextContent('2.51 XCH'));

    fireEvent.click(screen.getByTestId('home-balance-swap'));
    await waitFor(() => expect(store[BALANCE_UNIT_STORAGE_KEY]).toBe('usd'));
    unmount();

    // A fresh mount (simulating the popup reopening) reads the persisted preference back.
    renderWithProviders(<HomeScreen />);
    await waitFor(() => expect(screen.getByTestId('home-balance-value')).toHaveTextContent('$25.10'));
  });

  it('clicking swap does not also navigate to the Wallet tab (it is a sibling control, not nested)', async () => {
    const store = createStore();
    renderWithProviders(<HomeScreen />, { store });
    expect(await screen.findByTestId('home-balance-swap')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('home-balance-swap'));
    expect(store.getState().ui.tab).not.toBe('wallet');
  });

  it('tapping the balance value (not the swap button) still opens the Wallet tab', async () => {
    const store = createStore();
    renderWithProviders(<HomeScreen />, { store });
    expect(await screen.findByTestId('home-balance')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('home-balance'));
    expect(store.getState().ui.tab).toBe('wallet');
  });

  it('hides the swap control when the wallet is locked (nothing to swap)', async () => {
    mockSw(false);
    renderWithProviders(<HomeScreen />);
    expect(await screen.findByTestId('home-balance-locked')).toBeInTheDocument();
    expect(screen.queryByTestId('home-balance-swap')).not.toBeInTheDocument();
  });

  it('USD chosen but price unavailable: falls back to XCH, never a broken "$—"', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('coingecko') || u.includes('dexie')) return { ok: false, json: async () => ({}) };
      return { ok: true, json: async () => CATALOG };
    }));
    mockStorage({ [BALANCE_UNIT_STORAGE_KEY]: 'usd' });
    renderWithProviders(<HomeScreen />);

    await waitFor(() => expect(screen.getByTestId('home-balance-value')).toHaveTextContent('2.51 XCH'));
    expect(screen.getByTestId('home-balance-value')).not.toHaveTextContent('$');
    expect(await screen.findByTestId('home-balance-secondary')).toHaveTextContent('Value unavailable');
  });

  it('shows a loading skeleton on the prominent $ value while the price fetch is in flight — NEVER "unavailable" mid-fetch', async () => {
    let resolveCoingecko: () => void = () => {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes('coingecko')) {
          return new Promise((resolve) => {
            resolveCoingecko = () => resolve({ ok: true, json: async () => XCH_PRICE_JSON });
          });
        }
        if (u.includes('dexie')) return { ok: true, json: async () => DEXIE_JSON };
        return { ok: true, json: async () => CATALOG };
      }),
    );
    mockStorage({ [BALANCE_UNIT_STORAGE_KEY]: 'usd' });
    renderWithProviders(<HomeScreen />);

    // The coingecko fetch is deliberately held open: the $ (prominent) slot must show a skeleton,
    // not the "unavailable" text, and the always-known native amount still shows as secondary.
    expect(await screen.findByTestId('home-balance-value-loading')).toBeInTheDocument();
    expect(screen.getByTestId('home-balance-secondary')).toHaveTextContent('2.51 XCH');
    expect(screen.getByTestId('home-balance-secondary')).not.toHaveTextContent(/unavailable/i);

    resolveCoingecko();
    await waitFor(() => expect(screen.getByTestId('home-balance-value')).toHaveTextContent('$25.10'));
    expect(screen.queryByTestId('home-balance-value-loading')).not.toBeInTheDocument();
  });
});

describe('HomeScreen balance widget — fiat currency preference (#112)', () => {
  it('applies a persisted non-USD currency preference to the $ balance', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u === COINGECKO_FX_URL) return { ok: true, json: async () => ({ chia: { usd: 10, eur: 9 } }) };
        if (u.includes('coingecko')) return { ok: true, json: async () => XCH_PRICE_JSON };
        if (u.includes('dexie')) return { ok: true, json: async () => DEXIE_JSON };
        return { ok: true, json: async () => CATALOG };
      }),
    );
    mockStorage({ [BALANCE_UNIT_STORAGE_KEY]: 'usd', [FIAT_CURRENCY_STORAGE_KEY]: 'eur' });
    renderWithProviders(<HomeScreen />);

    // 2.51 XCH × $10 = $25.10 → × 0.9 eur/usd = €22.59.
    await waitFor(() => expect(screen.getByTestId('home-balance-value')).toHaveTextContent('€22.59'));
  });
});
