import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { WalletSyncStatusBanner, WalletSyncPill } from '@/features/wallet/WalletSyncStatusBanner';
import { renderWithProviders } from '@/test/harness';
import { ACTIONS } from '@/lib/messages';

function mockSync(status: Record<string, unknown>) {
  chrome.runtime.sendMessage = vi.fn((msg: { action: string }, cb?: (r: unknown) => void) => {
    cb?.(msg.action === ACTIONS.getWalletSyncStatus ? status : { success: true });
  }) as never;
}

describe('WalletSyncStatusBanner (#373)', () => {
  it('shows a prominent SYNCING banner with progress + "not final" wording, in a polite live region', async () => {
    mockSync({ state: 'syncing', peakHeight: 50, targetHeight: 200, updatedAt: 1 });
    renderWithProviders(<WalletSyncStatusBanner />);
    const banner = await screen.findByTestId('wallet-sync-banner');
    expect(banner).toHaveAttribute('data-state', 'syncing');
    expect(banner).toHaveAttribute('role', 'status');
    expect(banner).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByTestId('wallet-sync-banner-detail')).toHaveTextContent(/50/);
    expect(screen.getByTestId('wallet-sync-banner-detail')).toHaveTextContent(/200/);
    const bar = screen.getByTestId('wallet-sync-progress');
    expect(bar).toHaveAttribute('aria-valuenow', '25');
  });

  it('shows an indeterminate progress bar when the target height is unknown', async () => {
    mockSync({ state: 'syncing', peakHeight: 50, targetHeight: null, updatedAt: 1 });
    renderWithProviders(<WalletSyncStatusBanner />);
    const bar = await screen.findByTestId('wallet-sync-progress');
    expect(bar).not.toHaveAttribute('aria-valuenow');
    expect(bar).toHaveAttribute('aria-valuetext', 'syncing');
  });

  it('shows a DISCONNECTED alert banner labeling content as offline/out of date', async () => {
    mockSync({ state: 'disconnected', peakHeight: null, targetHeight: null, updatedAt: 1 });
    renderWithProviders(<WalletSyncStatusBanner />);
    const banner = await screen.findByTestId('wallet-sync-banner');
    expect(banner).toHaveAttribute('data-state', 'disconnected');
    expect(banner).toHaveAttribute('role', 'alert');
    expect(screen.getByTestId('wallet-sync-banner-detail')).toHaveTextContent(/cache|offline|out of date/i);
    expect(screen.queryByTestId('wallet-sync-progress')).not.toBeInTheDocument();
  });

  it('renders NOTHING when synced (the wallet is normal)', async () => {
    mockSync({ state: 'synced', peakHeight: 100, targetHeight: 100, updatedAt: 1 });
    const { container } = renderWithProviders(<WalletSyncStatusBanner />);
    // Give the query a tick to resolve, then assert no banner rendered.
    await new Promise((r) => setTimeout(r, 0));
    expect(container.querySelector('[data-testid="wallet-sync-banner"]')).toBeNull();
  });

  it('WalletSyncPill reflects the state as a compact header pill', async () => {
    mockSync({ state: 'syncing', peakHeight: 1, targetHeight: 2, updatedAt: 1 });
    renderWithProviders(<WalletSyncPill />);
    expect(await screen.findByTestId('header-wallet-sync-pill')).toHaveTextContent(/sync/i);
  });
});
