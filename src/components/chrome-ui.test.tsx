import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AppHeader } from '@/components/AppHeader';
import { AppFooter } from '@/components/AppFooter';
import { ExternalLink } from '@/components/ExternalLink';
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

describe('AppFooter', () => {
  it('shows the version and switches locale', async () => {
    renderWithProviders(<AppFooter />);
    expect(screen.getByTestId('app-version')).toHaveTextContent('v0.0.0-test');
    await userEvent.selectOptions(screen.getByTestId('locale-select'), 'ja');
    expect(screen.getByTestId('locale-select')).toHaveValue('ja');
  });

  it('switches theme (#111) and persists both prefs without clobbering unrelated settings', async () => {
    // A pre-existing unrelated setting (e.g. the §5.3 chain-node override) must survive a
    // locale/theme change — AppFooter must read-modify-write, never overwrite the whole blob.
    await chrome.storage.local.set({ 'wallet.settings': { chainRpcUrl: 'https://my.node/rpc' } });
    renderWithProviders(<AppFooter />);

    await userEvent.selectOptions(screen.getByTestId('theme-select'), 'dark');
    expect(screen.getByTestId('theme-select')).toHaveValue('dark');

    await userEvent.selectOptions(screen.getByTestId('locale-select'), 'de');
    expect(screen.getByTestId('locale-select')).toHaveValue('de');

    const { 'wallet.settings': saved } = await chrome.storage.local.get('wallet.settings');
    expect(saved).toMatchObject({ theme: 'dark', locale: 'de', chainRpcUrl: 'https://my.node/rpc' });
  });
});

describe('ExternalLink', () => {
  it('opens the url in a new tab via chrome.tabs', async () => {
    const create = vi.fn(() => Promise.resolve({ id: 1 }));
    chrome.tabs.create = create as never;
    renderWithProviders(
      <ExternalLink href="https://dig.net" testid="ext">
        link
      </ExternalLink>,
    );
    await userEvent.click(screen.getByTestId('ext'));
    expect(create).toHaveBeenCalledWith({ url: 'https://dig.net' });
  });
});
