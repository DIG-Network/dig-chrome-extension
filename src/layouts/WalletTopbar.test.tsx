import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { WalletTopbar } from '@/layouts/WalletTopbar';
import { renderWithProviders } from '@/test/harness';
import { createStore } from '@/app/store';
import { setTab, setWalletView } from '@/features/ui/uiSlice';

describe('WalletTopbar (#85 desktop app-bar)', () => {
  it('renders the active section title as the page-level heading', () => {
    const store = createStore();
    store.dispatch(setTab('wallet'));
    store.dispatch(setWalletView('activity'));
    renderWithProviders(<WalletTopbar />, { store });
    const heading = screen.getByTestId('topbar-title');
    expect(heading.tagName).toBe('H1');
    expect(heading).toHaveTextContent(/activity/i);
  });

  it('follows the route — Collectibles when the wallet collectibles view is active', () => {
    const store = createStore();
    store.dispatch(setTab('wallet'));
    store.dispatch(setWalletView('collectibles'));
    renderWithProviders(<WalletTopbar />, { store });
    expect(screen.getByTestId('topbar-title')).toHaveTextContent(/collectibles/i);
  });
});
