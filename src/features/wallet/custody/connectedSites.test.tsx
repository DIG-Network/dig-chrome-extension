import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/harness';
import { ConnectedSites } from '@/features/wallet/custody/ConnectedSites';

/**
 * Connected sites (#67 P0-4). Drives the component over the mocked SW seam: the list
 * (`listConnectedSites`) + the revoke mutations. Asserts the sites render, per-site revoke + revoke-all
 * reach the SW, and the empty state shows when no sites are connected.
 */

function mockSw(router: (m: { action: string; [k: string]: unknown }) => unknown) {
  const fn = vi.fn((msg: unknown, cb?: (r: unknown) => void) => {
    const reply = router(msg as { action: string; [k: string]: unknown });
    if (cb) cb(reply);
    return Promise.resolve(reply);
  });
  (chrome.runtime as unknown as { sendMessage: typeof fn }).sendMessage = fn;
  return fn;
}

const SITE = {
  origin: 'https://dapp.example',
  approved: true,
  addresses: ['xch1abc'],
  methods: ['chia_connect'],
  grantedAt: 1_700_000_000_000,
  lastUsed: 1_700_100_000_000,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ConnectedSites', () => {
  it('lists each connected site with a revoke control', async () => {
    mockSw((m) => {
      if (m.action === 'listConnectedSites') return { sites: [SITE] };
      return { success: true };
    });
    renderWithProviders(<ConnectedSites />);
    expect(await screen.findByTestId('connected-site-dapp.example')).toBeInTheDocument();
    expect(screen.getByTestId('connected-site-revoke-dapp.example')).toBeInTheDocument();
    expect(screen.getByTestId('connected-sites-revoke-all')).toBeInTheDocument();
  });

  it('per-site revoke sends the origin to the SW', async () => {
    const sw = mockSw((m) => {
      if (m.action === 'listConnectedSites') return { sites: [SITE] };
      if (m.action === 'revokeConnectedSite') return { success: true };
      return { success: true };
    });
    renderWithProviders(<ConnectedSites />);
    fireEvent.click(await screen.findByTestId('connected-site-revoke-dapp.example'));
    await waitFor(() => {
      expect(sw).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'revokeConnectedSite', origin: 'https://dapp.example' }),
        expect.anything(),
      );
    });
  });

  it('revoke-all calls the SW', async () => {
    const sw = mockSw((m) => {
      if (m.action === 'listConnectedSites') return { sites: [SITE] };
      if (m.action === 'revokeAllConnectedSites') return { success: true };
      return { success: true };
    });
    renderWithProviders(<ConnectedSites />);
    fireEvent.click(await screen.findByTestId('connected-sites-revoke-all'));
    await waitFor(() => {
      expect(sw).toHaveBeenCalledWith(expect.objectContaining({ action: 'revokeAllConnectedSites' }), expect.anything());
    });
  });

  it('shows the empty state when no sites are connected', async () => {
    mockSw((m) => {
      if (m.action === 'listConnectedSites') return { sites: [] };
      return { success: true };
    });
    renderWithProviders(<ConnectedSites />);
    expect(await screen.findByTestId('connected-sites-empty')).toBeInTheDocument();
  });
});
