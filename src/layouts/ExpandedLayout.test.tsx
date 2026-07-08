import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { ExpandedLayout } from '@/layouts/ExpandedLayout';
import { renderWithProviders } from '@/test/harness';
import { createStore } from '@/app/store';
import { setChainNetwork } from '@/features/ui/uiSlice';

describe('ExpandedLayout (fullscreen, #108 guardrail)', () => {
  it('shows no network badge on mainnet, a persistent one otherwise — the sidebar has no AppHeader of its own', () => {
    renderWithProviders(<ExpandedLayout surface="fullpage" />);
    expect(screen.queryByTestId('network-badge')).not.toBeInTheDocument();

    const store = createStore();
    store.dispatch(setChainNetwork('testnet'));
    renderWithProviders(<ExpandedLayout surface="fullpage" />, { store });
    expect(screen.getByTestId('network-badge')).toHaveTextContent(/testnet/i);
  });
});
