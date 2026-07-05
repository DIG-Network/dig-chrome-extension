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

/** A connected transport whose broker returns simple balances + an empty activity list. */
function connectedWithData(overrides: Partial<WalletTransport> = {}): WalletTransport {
  return makeTransport({
    getConnection: vi.fn(async () => ({ connected: true, address: 'xch1abcdefghij', network: 'mainnet', topic: 't' })),
    isConnected: vi.fn(async () => true),
    request: vi.fn(async (method: string) => {
      if (method === 'chip0002_getAssetBalance') return { confirmed: 2_510_000_000_000 };
      if (method === 'chia_getTransactions') return { transactions: [] };
      return {};
    }),
    ...overrides,
  });
}

const original = window.matchMedia;
beforeEach(() => {
  // Route lives in location.hash, which persists across tests in the shared jsdom document —
  // reset it so each test starts on the default (resolver) route.
  history.replaceState(null, '', '/');
  // The wallet tab now lands on the self-custody gate (#56). These shell tests exercise the
  // (Sage-broker) wallet body, so report an already-unlocked wallet from the SW; other actions
  // keep the default stub reply.
  (chrome.runtime as unknown as { sendMessage: unknown }).sendMessage = vi.fn(
    (msg: { action?: string } | undefined, cb?: (r: unknown) => void) => {
      const reply = msg?.action === 'getLockState' ? { lockState: 'unlocked' } : { success: true };
      if (cb) cb(reply);
      return Promise.resolve(reply);
    },
  );
});
afterEach(() => {
  window.matchMedia = original;
});

describe('App shell', () => {
  it('renders the 5-tab shell wallet-first (wallet default) + versioned footer', async () => {
    renderApp('popup', makeTransport());
    for (const t of ['wallet', 'apps', 'resolver', 'shield', 'control']) {
      expect(screen.getByTestId(`tab-${t}`)).toBeInTheDocument();
    }
    // Wallet is the default landing (ladder-of-needs); unlocked custody → the (Sage) body, which
    // is disconnected here → the connect gateway.
    expect(await screen.findByTestId('wallet-panel')).toBeInTheDocument();
    expect(await screen.findByTestId('wallet-connect-cta')).toBeInTheDocument();
    expect(screen.getByTestId('app-version')).toHaveTextContent('v0.0.0-test');
    expect(screen.getByTestId('popout-fullview')).toBeInTheDocument();
  });

  it('shows the connect gateway on the wallet tab when disconnected', async () => {
    renderApp('popup', makeTransport());
    await userEvent.click(screen.getByTestId('tab-wallet'));
    expect(await screen.findByTestId('wallet-connect-cta')).toBeInTheDocument();
  });

  it('renders the wallet Home (portfolio + assets) when connected, and switches sub-views', async () => {
    renderApp('popup', connectedWithData());
    await userEvent.click(screen.getByTestId('tab-wallet'));
    const hero = await screen.findByTestId('portfolio-value');
    await waitFor(() => expect(hero).toHaveTextContent('2.51'));
    expect(await screen.findByTestId('asset-xch')).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('seg-activity'));
    expect(await screen.findByTestId('wallet-activity')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('seg-trade'));
    expect(await screen.findByTestId('wallet-trade')).toBeInTheDocument();
  });

  it('opens the Send sheet from Home', async () => {
    renderApp('popup', connectedWithData());
    await userEvent.click(screen.getByTestId('tab-wallet'));
    await userEvent.click(await screen.findByTestId('action-send'));
    expect(await screen.findByTestId('send-sheet')).toBeInTheDocument();
    expect(screen.getByTestId('send-submit')).toBeInTheDocument();
  });

  it('embeds the explore.dig.net iframe on the Apps tab', async () => {
    renderApp('popup', makeTransport());
    await userEvent.click(screen.getByTestId('tab-apps'));
    const frame = await screen.findByTestId('apps-frame');
    expect(frame.getAttribute('src')).toBe('https://explore.dig.net/apps');
    expect(screen.getByTestId('apps-open-tab')).toBeInTheDocument();
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
