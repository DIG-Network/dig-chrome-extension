import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '@/app/App';
import { createStore } from '@/app/store';
import type { Surface } from '@/app/layout';
import { TOOLBAR_ENABLED_KEY } from '@/lib/toolbar';

function renderApp(surface: Surface) {
  const store = createStore();
  return { store, ...render(<App surface={surface} store={store} />) };
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
      else if (msg?.action === 'getActivity') reply = { events: [] };
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
    renderApp('popup');
    for (const t of ['home', 'wallet', 'apps', 'network']) {
      expect(screen.getByTestId(`tab-${t}`)).toBeInTheDocument();
    }
    // Home is the default landing (the mobile-OS launcher).
    expect(await screen.findByTestId('home-screen')).toBeInTheDocument();
    expect(screen.getByTestId('app-version')).toHaveTextContent('v0.0.0-test');
    expect(screen.getByTestId('popout-fullview')).toBeInTheDocument();
  });

  it('Home shows the wallet-balance widget + quick actions + dApp launcher', async () => {
    renderApp('popup');
    expect(await screen.findByTestId('home-balance')).toBeInTheDocument();
    expect(screen.getByTestId('home-quickactions')).toBeInTheDocument();
    expect(await screen.findByTestId('home-apps-grid')).toBeInTheDocument();
    // The balance widget → Wallet screen.
    await userEvent.click(screen.getByTestId('home-balance'));
    expect(await screen.findByTestId('custody-wallet')).toBeInTheDocument();
  });

  it('shows the custody portfolio + scanned assets on the wallet tab', async () => {
    renderApp('popup');
    await userEvent.click(screen.getByTestId('tab-wallet'));
    const hero = await screen.findByTestId('portfolio-value');
    await waitFor(() => expect(hero).toHaveTextContent('2.51')); // 2.51 XCH from the custody scan
    expect(await screen.findByTestId('asset-xch')).toBeInTheDocument();
  });

  it('shows the custody receive address on the dedicated Receive screen (#166)', async () => {
    renderApp('popup');
    await userEvent.click(screen.getByTestId('tab-wallet'));
    await screen.findByTestId('custody-wallet');
    await userEvent.click(screen.getByTestId('action-receive'));
    const addr = await screen.findByTestId('wallet-address');
    expect(addr).toHaveValue('xch1qqqqcustodyreceiveaddressqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqzzzz');
  });

  it('switches custody sub-views via the segmented control', async () => {
    renderApp('popup');
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
    renderApp('popup');
    await userEvent.click(screen.getByTestId('tab-apps'));
    expect(await screen.findByTestId('apps-launcher')).toBeInTheDocument();
    expect(screen.getByTestId('app-tile-chia-offer')).toBeInTheDocument();
    expect(screen.getByTestId('apps-open-tab')).toBeInTheDocument();
    expect(screen.queryByTestId('apps-frame')).not.toBeInTheDocument();
  });

  it('groups resolver/shield/control under the Network screen (every surface reachable)', async () => {
    renderApp('popup');
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
    renderApp('fullpage');
    expect(screen.getByTestId('popup-root')).toHaveAttribute('data-layout', 'expanded');
  });
});

describe('App shell — built-in DIG URN toolbar placement (#421)', () => {
  // The jsdom storage stub is module-level and persists across tests — clear the toggle each time.
  afterEach(async () => {
    await chrome.storage.local.remove(TOOLBAR_ENABLED_KEY);
  });

  it('renders NO built-in toolbar while the toggle is OFF (opt-in default)', async () => {
    renderApp('popup');
    await screen.findByTestId('popup-root');
    expect(screen.queryByTestId('builtin-dig-toolbar')).toBeNull();
  });

  it('mounts the built-in URN bar flush at the TOP of the shared shell when enabled (compact popup)', async () => {
    await chrome.storage.local.set({ [TOOLBAR_ENABLED_KEY]: true });
    renderApp('popup');
    // Mounted exactly once, in the shared app-shell (not per-page / not duplicated).
    const bars = await screen.findAllByTestId('builtin-dig-toolbar');
    expect(bars).toHaveLength(1);
    // Flush-top: the toolbar is the FIRST child of the shared shell — nothing (no header/container
    // inset) renders above it.
    const shell = screen.getByTestId('shell-root');
    expect(shell.firstElementChild).toBe(bars[0]);
  });

  it('mounts the built-in bar above the sidebar workspace on the expanded (fullscreen) surface', async () => {
    window.matchMedia = vi.fn().mockImplementation((q: string) => ({
      matches: true,
      media: q,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })) as unknown as typeof window.matchMedia;
    await chrome.storage.local.set({ [TOOLBAR_ENABLED_KEY]: true });
    renderApp('fullpage');
    const bar = await screen.findByTestId('builtin-dig-toolbar');
    const shell = screen.getByTestId('shell-root');
    expect(shell.firstElementChild).toBe(bar);
    // …and it sits ABOVE the expanded layout root (the sidebar + workspace), spanning the window.
    const layout = screen.getByTestId('popup-root');
    expect(bar.compareDocumentPosition(layout) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
