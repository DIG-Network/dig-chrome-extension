import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WalletSidebar } from '@/layouts/WalletSidebar';
import { renderWithProviders } from '@/test/harness';
import { createStore } from '@/app/store';
import { setChainNetwork } from '@/features/ui/uiSlice';
import { DESKTOP_NAV } from '@/layouts/desktopNav';

describe('WalletSidebar (#85 desktop nav)', () => {
  it('renders every desktop nav item as a labelled, testable control', () => {
    renderWithProviders(<WalletSidebar surface="fullpage" />);
    const nav = screen.getByRole('navigation', { name: /sidebar navigation/i });
    expect(nav).toBeInTheDocument();
    for (const item of DESKTOP_NAV) {
      expect(screen.getByTestId(`nav-${item.key}`)).toBeInTheDocument();
    }
  });

  it('marks the item for the current route as the current page (Wallet by default)', () => {
    const store = createStore();
    renderWithProviders(<WalletSidebar surface="fullpage" />, { store });
    // Default route is the mobile Home launcher.
    expect(screen.getByTestId('nav-home')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('nav-activity')).not.toHaveAttribute('aria-current');
  });

  it('navigates the SHARED route on click — a wallet sub-view sets both tab and walletView', async () => {
    const { store } = renderWithProviders(<WalletSidebar surface="fullpage" />);
    await userEvent.click(screen.getByTestId('nav-activity'));
    expect(store.getState().ui.tab).toBe('wallet');
    expect(store.getState().ui.walletView).toBe('activity');
    // A non-wallet tab just sets the tab.
    await userEvent.click(screen.getByTestId('nav-network'));
    expect(store.getState().ui.tab).toBe('network');
  });

  it('shows the settings entry, and the non-mainnet guardrail badge only off mainnet (#108)', () => {
    renderWithProviders(<WalletSidebar surface="fullpage" />);
    expect(screen.getByTestId('open-options')).toBeInTheDocument();
    expect(screen.queryByTestId('network-badge')).not.toBeInTheDocument();

    const store = createStore();
    store.dispatch(setChainNetwork('testnet'));
    renderWithProviders(<WalletSidebar surface="fullpage" />, { store });
    expect(screen.getByTestId('network-badge')).toHaveTextContent(/testnet/i);
  });
});
