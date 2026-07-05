import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '@/app/App';
import { createStore } from '@/app/store';
import { makeTransport } from '@/test/harness';
import type { WalletTransport } from '@/features/wallet/transport';
import type { Surface } from '@/app/layout';

function renderApp(surface: Surface, transport: WalletTransport) {
  const store = createStore(transport);
  return { store, ...render(<App surface={surface} store={store} transport={transport} />) };
}

const original = window.matchMedia;
beforeEach(() => {
  // Route lives in location.hash, which persists across tests in the shared jsdom document —
  // reset it so each test starts on the default (resolver) route.
  history.replaceState(null, '', '/');
  // The wallet tab lands on the self-custody gate (#56). Report an already-unlocked custody wallet
  // + a balance scan + a receive address from the SW so the shell tests exercise the custody body.
  (chrome.runtime as unknown as { sendMessage: unknown }).sendMessage = vi.fn(
    (msg: { action?: string } | undefined, cb?: (r: unknown) => void) => {
      let reply: unknown = { success: true };
      if (msg?.action === 'getLockState') reply = { lockState: 'unlocked' };
      else if (msg?.action === 'getCustodyBalances') reply = { balances: { xch: 2_510_000_000_000, cats: {} } };
      else if (msg?.action === 'getReceiveAddress') reply = { address: 'xch1qqqqcustodyreceiveaddressqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqzzzz' };
      else if (msg?.action === 'getActivity') reply = { events: [], cursorHeight: 0 };
      else if (msg?.action === 'getDigNodeStatus') reply = { reachable: false, base: null };
      if (cb) cb(reply);
      return Promise.resolve(reply);
    },
  );
  // The mobile-OS Home (the default screen) fetches explore's /store.json directly — stub it.
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({ apps: [{ slug: 'chia-offer', name: 'Chia-Offer', icon: 'https://explore.dig.net/catalog/chia-offer/icon-512.png', link: 'https://chia-offer.on.dig.net/', category: 'tools', featured: true }] }),
  })));
});
afterEach(() => {
  window.matchMedia = original;
  vi.unstubAllGlobals();
});

describe('App shell', () => {
  it('renders the mobile-OS bottom nav (Home · Wallet · Apps · Network), Home default + versioned footer', async () => {
    renderApp('popup', makeTransport());
    for (const t of ['home', 'wallet', 'apps', 'network']) {
      expect(screen.getByTestId(`tab-${t}`)).toBeInTheDocument();
    }
    // Home is the default landing (the mobile-OS launcher).
    expect(await screen.findByTestId('home-screen')).toBeInTheDocument();
    expect(screen.getByTestId('app-version')).toHaveTextContent('v0.0.0-test');
    expect(screen.getByTestId('popout-fullview')).toBeInTheDocument();
  });

  it('Home shows the wallet-balance widget + quick actions + dApp launcher', async () => {
    renderApp('popup', makeTransport());
    expect(await screen.findByTestId('home-balance')).toBeInTheDocument();
    expect(screen.getByTestId('home-quickactions')).toBeInTheDocument();
    expect(await screen.findByTestId('home-apps-grid')).toBeInTheDocument();
    // The balance widget → Wallet screen.
    await userEvent.click(screen.getByTestId('home-balance'));
    expect(await screen.findByTestId('custody-wallet')).toBeInTheDocument();
  });

  it('shows the custody portfolio + scanned assets on the wallet tab', async () => {
    renderApp('popup', makeTransport());
    await userEvent.click(screen.getByTestId('tab-wallet'));
    const hero = await screen.findByTestId('portfolio-value');
    await waitFor(() => expect(hero).toHaveTextContent('2.51')); // 2.51 XCH from the custody scan
    expect(await screen.findByTestId('asset-xch')).toBeInTheDocument();
  });

  it('shows the custody receive address on Home', async () => {
    renderApp('popup', makeTransport());
    await userEvent.click(screen.getByTestId('tab-wallet'));
    const addr = await screen.findByTestId('wallet-address');
    expect(addr).toHaveValue('xch1qqqqcustodyreceiveaddressqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqzzzz');
  });

  it('switches custody sub-views via the segmented control', async () => {
    renderApp('popup', makeTransport());
    await userEvent.click(screen.getByTestId('tab-wallet'));
    await screen.findByTestId('custody-wallet');
    await userEvent.click(screen.getByTestId('seg-activity'));
    expect(await screen.findByTestId('custody-activity')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('seg-trade'));
    expect(await screen.findByTestId('custody-trade')).toBeInTheDocument();
  });

  it('shows the native dApp launcher on the Apps tab (no iframe)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ apps: [{ slug: 'chia-offer', name: 'Chia-Offer', icon: 'https://explore.dig.net/catalog/chia-offer/icon-512.png', link: 'https://chia-offer.on.dig.net/', category: 'tools', featured: true }] }),
    })));
    renderApp('popup', makeTransport());
    await userEvent.click(screen.getByTestId('tab-apps'));
    expect(await screen.findByTestId('apps-launcher')).toBeInTheDocument();
    expect(screen.getByTestId('app-tile-chia-offer')).toBeInTheDocument();
    expect(screen.getByTestId('apps-open-tab')).toBeInTheDocument();
    expect(screen.queryByTestId('apps-frame')).not.toBeInTheDocument();
  });

  it('groups resolver/shield/control under the Network screen (every surface reachable)', async () => {
    renderApp('popup', makeTransport());
    await userEvent.click(screen.getByTestId('tab-network'));
    // Network defaults to the resolver sub-view.
    expect(await screen.findByTestId('network-panel')).toBeInTheDocument();
    expect(await screen.findByTestId('resolver-panel')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('seg-shield'));
    expect(await screen.findByTestId('shield-panel')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('seg-control'));
    expect(await screen.findByTestId('control-panel')).toBeInTheDocument();
  });

  it('uses the expanded (sidebar) layout for a wide app.html surface', async () => {
    window.matchMedia = vi.fn().mockImplementation((q: string) => ({
      matches: true,
      media: q,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })) as unknown as typeof window.matchMedia;
    renderApp('fullpage', makeTransport());
    expect(screen.getByTestId('popup-root')).toHaveAttribute('data-layout', 'expanded');
  });
});
