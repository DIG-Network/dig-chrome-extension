import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AppFooter } from '@/app/AppFooter';
import { renderWithProviders } from '@/test/harness';

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
