import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/harness';
import { createStore } from '@/app/store';
import { HomeScreen } from '@/features/home/HomeScreen';
import { BALANCE_UNIT_STORAGE_KEY } from '@/features/wallet/balanceUnit';

const CATALOG = { apps: [{ slug: 'chia-offer', name: 'Chia-Offer', icon: 'https://explore.dig.net/catalog/chia-offer/icon-512.png', link: 'https://chia-offer.on.dig.net/', category: 'tools', featured: true }] };

/** CoinGecko + dexie responses for a deterministic XCH price ($10, no CATs held here). */
const XCH_PRICE_JSON = { chia: { usd: 10, usd_24h_change: -5 } };
const DEXIE_JSON = { tickers: [] };

function mockSw(unlocked = true) {
  (chrome.runtime as unknown as { sendMessage: unknown }).sendMessage = vi.fn((msg: { action?: string } | undefined, cb?: (r: unknown) => void) => {
    let reply: unknown = { success: true };
    if (msg?.action === 'getLockState') reply = { lockState: unlocked ? 'unlocked' : 'locked' };
    else if (msg?.action === 'getCustodyBalances') reply = { balances: { xch: 2_510_000_000_000, cats: {} } };
    else if (msg?.action === 'getActivity') reply = { events: [], cursorHeight: 0 };
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
  it('renders the balance widget, quick actions, status, and dApp launcher', async () => {
    renderWithProviders(<HomeScreen />);
    expect(screen.getByTestId('home-screen')).toBeInTheDocument();
    expect(screen.getByTestId('home-quickactions')).toBeInTheDocument();
    expect(screen.getByTestId('home-status')).toBeInTheDocument();
    expect(await screen.findByTestId('home-balance-value')).toBeInTheDocument();
    expect(await screen.findByTestId('home-apps-grid')).toBeInTheDocument();
    expect(screen.getByTestId('app-tile-chia-offer')).toBeInTheDocument();
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
    await waitFor(() => expect(screen.getByTestId('home-balance-swap')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('home-balance-swap'));
    expect(store.getState().ui.tab).not.toBe('wallet');
  });

  it('tapping the balance value (not the swap button) still opens the Wallet tab', async () => {
    const store = createStore();
    renderWithProviders(<HomeScreen />, { store });
    await waitFor(() => expect(screen.getByTestId('home-balance')).toBeInTheDocument());
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
    await waitFor(() => expect(screen.getByTestId('home-balance-value-loading')).toBeInTheDocument());
    expect(screen.getByTestId('home-balance-secondary')).toHaveTextContent('2.51 XCH');
    expect(screen.getByTestId('home-balance-secondary')).not.toHaveTextContent(/unavailable/i);

    resolveCoingecko();
    await waitFor(() => expect(screen.getByTestId('home-balance-value')).toHaveTextContent('$25.10'));
    expect(screen.queryByTestId('home-balance-value-loading')).not.toBeInTheDocument();
  });
});
