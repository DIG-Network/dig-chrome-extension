import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '@/test/harness';
import { createStore } from '@/app/store';
import { HomeScreen } from '@/features/home/HomeScreen';

const CATALOG = { apps: [{ slug: 'chia-offer', name: 'Chia-Offer', icon: 'https://explore.dig.net/catalog/chia-offer/icon-512.png', link: 'https://chia-offer.on.dig.net/', category: 'tools', featured: true }] };

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

beforeEach(() => {
  (chrome as unknown as { storage: unknown }).storage = { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) } };
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => CATALOG })));
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
