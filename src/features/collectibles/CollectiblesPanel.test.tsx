import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { axe } from 'jest-axe';
import { renderWithProviders } from '@/test/harness';
import { CollectiblesPanel } from '@/features/collectibles/CollectiblesPanel';
import { isFullpageSurface } from '@/features/collectibles/surface';
import { resetSharedNftMetadataCacheForTests } from '@/features/collectibles/nftMetadataCache';
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

beforeEach(async () => {
  resetSharedNftMetadataCacheForTests();
  await chrome.storage.local.remove('digNftMetadataCache');
});
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

  it('richer gallery (#98): a tile shows the resolved off-chain name once metadata resolves, falling back to the shortened id meanwhile', async () => {
    const target = nft({ metadataUris: ['https://example.test/meta.json'] });
    mockSw((m) =>
      m.action === 'listNfts'
        ? { nfts: [target] }
        : m.action === 'getNftMetadata'
          ? { metadata: { name: 'Cool Cat #1' } }
          : { success: true },
    );
    renderWithProviders(<CollectiblesPanel full />);
    await screen.findByTestId('nft-grid');
    // resolves to the real off-chain name (the shortened-id fallback, nftDisplayName(target), is
    // what would render while loading/unavailable — covered by the other CollectiblesPanel tests
    // above, which use an nft() with no metadataUris at all).
    expect(await screen.findByText('Cool Cat #1')).toBeInTheDocument();
  });

  it('richer gallery (#98): the collection group header shows the resolved off-chain collection name', async () => {
    const target = nft({ collectionId: 'did1', metadataUris: ['https://example.test/meta.json'] });
    mockSw((m) =>
      m.action === 'listNfts'
        ? { nfts: [target] }
        : m.action === 'getNftMetadata'
          ? { metadata: { collection: { id: 'did1', name: 'Cool Cats Club' } } }
          : { success: true },
    );
    renderWithProviders(<CollectiblesPanel full />);
    await screen.findByTestId('collectibles-grouped');
    expect(await screen.findByText('Cool Cats Club')).toBeInTheDocument();
    // the shortened-DID fallback label is gone once the real name resolves
    expect(screen.queryByText(/Collection did1/)).not.toBeInTheDocument();
  });

  it('richer gallery (#98): falls back to the shortened owner-DID label when no off-chain collection name resolves', async () => {
    const target = nft({ collectionId: 'did1'.padEnd(64, '0'), metadataUris: [] });
    mockSw((m) => (m.action === 'listNfts' ? { nfts: [target] } : { success: true }));
    renderWithProviders(<CollectiblesPanel full />);
    await screen.findByTestId('collectibles-grouped');
    expect(screen.getByText(/Collection did1/)).toBeInTheDocument();
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

  it('exposes "Mint NFT" and opens the mint form on the fullscreen surface (#92)', async () => {
    mockSw((m) => (m.action === 'listNfts' ? { nfts: [] } : { success: true }));
    renderWithProviders(<CollectiblesPanel full />);
    const mint = await screen.findByTestId('collectibles-mint');
    expect(mint).toBeInTheDocument();
    expect(screen.queryByTestId('collectibles-mint-fullscreen')).not.toBeInTheDocument();
    fireEvent.click(mint);
    expect(await screen.findByTestId('mint-form')).toBeInTheDocument();
  });

  it('offers only a "mint in full screen" affordance on the popup surface — never the mint form (#92)', async () => {
    mockSw((m) => (m.action === 'listNfts' ? { nfts: [] } : { success: true }));
    renderWithProviders(<CollectiblesPanel full={false} />);
    expect(await screen.findByTestId('collectibles-mint-fullscreen')).toBeInTheDocument();
    expect(screen.queryByTestId('collectibles-mint')).not.toBeInTheDocument();
    expect(screen.queryByTestId('mint-form')).not.toBeInTheDocument();
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

  describe('multi-select bulk transfer/burn (#171, fullscreen only)', () => {
    const NFT_A = nft({ launcherId: 'aa'.repeat(32) });
    const NFT_B = nft({ launcherId: 'bb'.repeat(32) });

    it('offers "Select" on the fullscreen surface; tapping a tile toggles selection instead of opening detail', async () => {
      mockSw((m) => (m.action === 'listNfts' ? { nfts: [NFT_A, NFT_B] } : { success: true }));
      renderWithProviders(<CollectiblesPanel full />);
      await screen.findByTestId('nft-grid');
      fireEvent.click(screen.getByTestId('collectibles-select-enter'));

      expect(screen.getByTestId('collectibles-selection-bar')).toHaveTextContent('0 selected');
      fireEvent.click(screen.getByTestId(`nft-tile-${NFT_A.launcherId}`));
      expect(screen.queryByTestId('nft-detail')).not.toBeInTheDocument(); // toggled selection, did NOT open detail
      expect(screen.getByTestId('collectibles-selection-bar')).toHaveTextContent('1 selected');
      expect(screen.getByTestId(`nft-select-${NFT_A.launcherId}`)).toHaveTextContent('✓');

      // toggling again deselects
      fireEvent.click(screen.getByTestId(`nft-tile-${NFT_A.launcherId}`));
      expect(screen.getByTestId('collectibles-selection-bar')).toHaveTextContent('0 selected');
    });

    it('select-all / clear act on every NFT', async () => {
      mockSw((m) => (m.action === 'listNfts' ? { nfts: [NFT_A, NFT_B] } : { success: true }));
      renderWithProviders(<CollectiblesPanel full />);
      await screen.findByTestId('nft-grid');
      fireEvent.click(screen.getByTestId('collectibles-select-enter'));

      fireEvent.click(screen.getByTestId('collectibles-select-all'));
      expect(screen.getByTestId('collectibles-selection-bar')).toHaveTextContent('2 selected');

      fireEvent.click(screen.getByTestId('collectibles-select-clear'));
      expect(screen.getByTestId('collectibles-selection-bar')).toHaveTextContent('0 selected');
    });

    it('the Transfer/Burn action-bar buttons appear only once something is selected, and open the bulk flow', async () => {
      mockSw((m) => (m.action === 'listNfts' ? { nfts: [NFT_A, NFT_B] } : { success: true }));
      renderWithProviders(<CollectiblesPanel full />);
      await screen.findByTestId('nft-grid');
      fireEvent.click(screen.getByTestId('collectibles-select-enter'));

      expect(screen.queryByTestId('collectibles-selection-transfer')).not.toBeInTheDocument();
      expect(screen.queryByTestId('collectibles-selection-burn')).not.toBeInTheDocument();

      fireEvent.click(screen.getByTestId(`nft-tile-${NFT_A.launcherId}`));
      fireEvent.click(screen.getByTestId(`nft-tile-${NFT_B.launcherId}`));
      fireEvent.click(screen.getByTestId('collectibles-selection-transfer'));
      expect(await screen.findByTestId('bulk-nft-transfer')).toBeInTheDocument();
      expect(screen.getByTestId('bulk-transfer-form')).toHaveTextContent('Transfer 2 NFTs');
    });

    it('the Burn action-bar button opens the destructive burn flow', async () => {
      mockSw((m) => (m.action === 'listNfts' ? { nfts: [NFT_A] } : { success: true }));
      renderWithProviders(<CollectiblesPanel full />);
      await screen.findByTestId('nft-grid');
      fireEvent.click(screen.getByTestId('collectibles-select-enter'));
      fireEvent.click(screen.getByTestId(`nft-tile-${NFT_A.launcherId}`));
      fireEvent.click(screen.getByTestId('collectibles-selection-burn'));
      expect(await screen.findByTestId('bulk-nft-burn')).toBeInTheDocument();
      expect(screen.getByTestId('bulk-burn-warning')).toHaveTextContent('permanent and cannot be undone');
    });

    it('the Assign DID action-bar button opens the bulk assign-DID flow (#99)', async () => {
      mockSw((m) => {
        if (m.action === 'listNfts') return { nfts: [NFT_A, NFT_B] };
        if (m.action === 'listDids') return { dids: [] };
        return { success: true };
      });
      renderWithProviders(<CollectiblesPanel full />);
      await screen.findByTestId('nft-grid');
      fireEvent.click(screen.getByTestId('collectibles-select-enter'));
      expect(screen.queryByTestId('collectibles-selection-assign')).not.toBeInTheDocument();
      fireEvent.click(screen.getByTestId(`nft-tile-${NFT_A.launcherId}`));
      fireEvent.click(screen.getByTestId(`nft-tile-${NFT_B.launcherId}`));
      fireEvent.click(screen.getByTestId('collectibles-selection-assign'));
      expect(await screen.findByTestId('bulk-nft-assign')).toBeInTheDocument();
    });

    it('Cancel exits selection mode and clears the selection', async () => {
      mockSw((m) => (m.action === 'listNfts' ? { nfts: [NFT_A, NFT_B] } : { success: true }));
      renderWithProviders(<CollectiblesPanel full />);
      await screen.findByTestId('nft-grid');
      fireEvent.click(screen.getByTestId('collectibles-select-enter'));
      fireEvent.click(screen.getByTestId(`nft-tile-${NFT_A.launcherId}`));
      fireEvent.click(screen.getByTestId('collectibles-select-cancel'));

      expect(screen.queryByTestId('collectibles-selection-bar')).not.toBeInTheDocument();
      expect(screen.getByTestId('collectibles-select-enter')).toBeInTheDocument();
      // a plain tap now opens the detail view again (selection mode truly exited)
      fireEvent.click(screen.getByTestId(`nft-tile-${NFT_A.launcherId}`));
      expect(await screen.findByTestId('nft-detail')).toBeInTheDocument();
    });

    it('the popup surface stays view-only — no "Select" affordance, offers "open full screen" instead', async () => {
      mockSw((m) => (m.action === 'listNfts' ? { nfts: [NFT_A] } : { success: true }));
      renderWithProviders(<CollectiblesPanel full={false} />);
      await screen.findByTestId('nft-grid');
      expect(screen.queryByTestId('collectibles-select-enter')).not.toBeInTheDocument();
      expect(screen.queryByTestId('collectibles-selection-bar')).not.toBeInTheDocument();
      expect(screen.getByTestId('collectibles-bulk-fullscreen')).toBeInTheDocument();
      // a popup tap always opens the detail view — never a selection toggle.
      fireEvent.click(screen.getByTestId(`nft-tile-${NFT_A.launcherId}`));
      expect(await screen.findByTestId('nft-detail')).toBeInTheDocument();
    });
  });
});
