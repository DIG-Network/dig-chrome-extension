import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { axe } from 'jest-axe';
import { renderWithProviders } from '@/test/harness';
import { CollectiblesPanel } from '@/features/collectibles/CollectiblesPanel';
import { isFullpageSurface } from '@/features/collectibles/surface';
import type { WalletNft } from '@/offscreen/nfts';

function nft(over: Partial<WalletNft> = {}): WalletNft {
  return {
    launcherId: 'ab'.repeat(32),
    coinId: 'cd'.repeat(32),
    p2PuzzleHash: 'ef'.repeat(32),
    collectionId: null,
    editionNumber: '1',
    editionTotal: '1',
    royaltyBasisPoints: 0,
    royaltyPuzzleHash: '00'.repeat(32),
    dataUris: [],
    dataHash: null,
    metadataUris: [],
    metadataHash: null,
    licenseUris: [],
    ...over,
  };
}

function mockSw(router: (m: { action: string; [k: string]: unknown }) => unknown) {
  const fn = vi.fn((msg: unknown, cb?: (r: unknown) => void) => {
    const reply = router(msg as { action: string; [k: string]: unknown });
    if (cb) cb(reply);
    return Promise.resolve(reply);
  });
  (chrome.runtime as unknown as { sendMessage: typeof fn }).sendMessage = fn;
  return fn;
}

const manyNfts = (n: number) =>
  Array.from({ length: n }, (_, i) => nft({ launcherId: i.toString(16).padStart(2, '0').repeat(32) }));

afterEach(() => vi.restoreAllMocks());

describe('isFullpageSurface', () => {
  it('is true for app.html and false for popup.html', () => {
    expect(isFullpageSurface('/app.html')).toBe(true);
    expect(isFullpageSurface('/app.html#wallet/collectibles')).toBe(true);
    expect(isFullpageSurface('/popup.html')).toBe(false);
    expect(isFullpageSurface('')).toBe(false);
  });
});

describe('CollectiblesPanel', () => {
  it('shows the loading state then the grid on success', async () => {
    mockSw((m) => (m.action === 'listNfts' ? { nfts: [nft()] } : { success: true }));
    renderWithProviders(<CollectiblesPanel full />);
    expect(await screen.findByTestId('nft-grid')).toBeInTheDocument();
    expect(screen.getByTestId(`nft-tile-${'ab'.repeat(32)}`)).toBeInTheDocument();
  });

  it('shows the empty state when the wallet has no NFTs', async () => {
    mockSw((m) => (m.action === 'listNfts' ? { nfts: [] } : { success: true }));
    renderWithProviders(<CollectiblesPanel full />);
    expect(await screen.findByTestId('collectibles-empty')).toBeInTheDocument();
  });

  it('shows the error state + retry when the scan fails', async () => {
    mockSw((m) => (m.action === 'listNfts' ? { success: false, code: 'CHAIN_UNAVAILABLE' } : { success: true }));
    renderWithProviders(<CollectiblesPanel full />);
    expect(await screen.findByTestId('collectibles-error')).toBeInTheDocument();
  });

  it('groups by collection on the full-page surface', async () => {
    mockSw((m) =>
      m.action === 'listNfts'
        ? { nfts: [nft({ launcherId: 'a1'.repeat(32), collectionId: 'did1' }), nft({ launcherId: 'b2'.repeat(32) })] }
        : { success: true },
    );
    renderWithProviders(<CollectiblesPanel full />);
    expect(await screen.findByTestId('collectibles-grouped')).toBeInTheDocument();
    expect(screen.getByText(/Collection/)).toBeInTheDocument();
    expect(screen.getByText('Ungrouped')).toBeInTheDocument();
  });

  it('caps the grid and offers "See all" on the constrained popup surface', async () => {
    mockSw((m) => (m.action === 'listNfts' ? { nfts: manyNfts(8) } : { success: true }));
    renderWithProviders(<CollectiblesPanel full={false} />);
    expect(await screen.findByTestId('collectibles-see-all')).toBeInTheDocument();
    // capped to POPUP_LIMIT (6) tiles
    expect(screen.getAllByRole('listitem')).toHaveLength(6);
  });

  it('has no WCAG violations (grid)', async () => {
    mockSw((m) => (m.action === 'listNfts' ? { nfts: [nft({ collectionId: 'did1' })] } : { success: true }));
    const { container } = renderWithProviders(<CollectiblesPanel full />);
    await screen.findByTestId('nft-grid');
    expect((await axe(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
  });

  it('opens the detail view when a tile is clicked', async () => {
    mockSw((m) => (m.action === 'listNfts' ? { nfts: [nft()] } : { success: true }));
    renderWithProviders(<CollectiblesPanel full />);
    fireEvent.click(await screen.findByTestId(`nft-tile-${'ab'.repeat(32)}`));
    expect(await screen.findByTestId('nft-detail')).toBeInTheDocument();
    // back returns to the grid
    fireEvent.click(screen.getByTestId('nft-detail-back'));
    expect(await screen.findByTestId('nft-grid')).toBeInTheDocument();
  });
});
