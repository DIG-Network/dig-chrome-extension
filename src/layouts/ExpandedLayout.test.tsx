import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { ExpandedLayout } from '@/layouts/ExpandedLayout';
import { renderWithProviders } from '@/test/harness';
import { createStore } from '@/app/store';
import { setChainNetwork } from '@/features/ui/uiSlice';

describe('ExpandedLayout (desktop wallet workspace, #85)', () => {
  it('composes the desktop workspace: sidebar nav + app-bar + width-using content', () => {
    renderWithProviders(<ExpandedLayout surface="fullpage" />);
    const root = screen.getByTestId('popup-root');
    expect(root).toHaveAttribute('data-layout', 'expanded');
    // The persistent sidebar (flattened section nav) and the app-bar title are present.
    expect(screen.getByRole('navigation', { name: /sidebar navigation/i })).toBeInTheDocument();
    expect(screen.getByTestId('nav-wallet')).toBeInTheDocument();
    expect(screen.getByTestId('wallet-topbar')).toBeInTheDocument();
  });

  it('shows no network badge on mainnet, a persistent one otherwise — the sidebar carries the #108 guardrail', () => {
    renderWithProviders(<ExpandedLayout surface="fullpage" />);
    expect(screen.queryByTestId('network-badge')).not.toBeInTheDocument();

    const store = createStore();
    store.dispatch(setChainNetwork('testnet'));
    renderWithProviders(<ExpandedLayout surface="fullpage" />, { store });
    expect(screen.getByTestId('network-badge')).toHaveTextContent(/testnet/i);
  });
});
