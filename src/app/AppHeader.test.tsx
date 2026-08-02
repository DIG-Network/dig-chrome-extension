import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AppHeader } from '@/app/AppHeader';
import { renderWithProviders } from '@/test/harness';
import { createStore } from '@/app/store';
import { setChainNetwork } from '@/features/ui/uiSlice';

describe('AppHeader', () => {
  it('shows no network badge on mainnet, a persistent TESTNET badge otherwise (#108)', () => {
    renderWithProviders(<AppHeader surface="popup" />);
    expect(screen.queryByTestId('network-badge')).not.toBeInTheDocument();

    const store = createStore();
    store.dispatch(setChainNetwork('testnet'));
    renderWithProviders(<AppHeader surface="popup" />, { store });
    expect(screen.getByTestId('network-badge')).toHaveTextContent(/testnet/i);
  });

  it('opens settings + pops out to the full page', async () => {
    const openOptions = vi.fn();
    chrome.runtime.openOptionsPage = openOptions as never;
    chrome.tabs.query = vi.fn(async () => []) as never;
    const create = vi.fn(async () => ({ id: 1 }));
    chrome.tabs.create = create as never;
    renderWithProviders(<AppHeader surface="popup" />);
    await userEvent.click(screen.getByTestId('open-options'));
    expect(openOptions).toHaveBeenCalled();
    await userEvent.click(screen.getByTestId('popout-fullview'));
    expect(create).toHaveBeenCalled();
  });

  it('hides pop-out on the fullpage surface', () => {
    renderWithProviders(<AppHeader surface="fullpage" />);
    expect(screen.queryByTestId('popout-fullview')).not.toBeInTheDocument();
  });
});
