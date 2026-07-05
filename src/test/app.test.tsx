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
      if (cb) cb(reply);
      return Promise.resolve(reply);
    },
  );
});
afterEach(() => {
  window.matchMedia = original;
  vi.unstubAllGlobals();
});

describe('App shell', () => {
  it('renders the 5-tab shell wallet-first (wallet default) + versioned footer', async () => {
    renderApp('popup', makeTransport());
    for (const t of ['wallet', 'apps', 'resolver', 'shield', 'control']) {
      expect(screen.getByTestId(`tab-${t}`)).toBeInTheDocument();
    }
    // Wallet is the default landing; the unlocked self-custody wallet renders its balances body.
    expect(await screen.findByTestId('custody-wallet')).toBeInTheDocument();
    expect(screen.getByTestId('app-version')).toHaveTextContent('v0.0.0-test');
    expect(screen.getByTestId('popout-fullview')).toBeInTheDocument();
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

  it('renders the resolver, shield, and control tabs', async () => {
    renderApp('popup', makeTransport());
    await userEvent.click(screen.getByTestId('tab-shield'));
    expect(await screen.findByTestId('shield-panel')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('tab-control'));
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
