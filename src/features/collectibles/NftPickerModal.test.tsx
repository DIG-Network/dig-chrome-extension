import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { axe } from 'jest-axe';
import { renderWithProviders } from '@/test/harness';
import { NftPickerModal } from '@/features/collectibles/NftPickerModal';
import type { WalletNft } from '@/offscreen/nfts';

function nft(over: Partial<WalletNft> & { launcherId: string }): WalletNft {
  return {
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

const NFT_A = nft({ launcherId: 'aa'.repeat(32) });
const NFT_B = nft({ launcherId: 'bb'.repeat(32) });
const NFT_C = nft({ launcherId: 'cc'.repeat(32), collectionId: 'dd'.repeat(32) });

const manyNfts = (n: number) =>
  Array.from({ length: n }, (_, i) => nft({ launcherId: i.toString(16).padStart(2, '0').repeat(32) }));

afterEach(() => vi.restoreAllMocks());

describe('NftPickerModal (#170 — XL modal NFT selection)', () => {
  it('shows the loading state, then a multi-select grid of the wallet NFTs', async () => {
    mockSw((m) => (m.action === 'listNfts' ? { nfts: [NFT_A, NFT_B] } : { success: true }));
    renderWithProviders(<NftPickerModal onConfirm={() => {}} onClose={() => {}} />);
    expect(await screen.findByTestId('nft-grid')).toBeInTheDocument();
    expect(screen.getByTestId(`nft-tile-${NFT_A.launcherId}`)).toBeInTheDocument();
    expect(screen.getByTestId(`nft-tile-${NFT_B.launcherId}`)).toBeInTheDocument();
  });

  it('shows the empty state when the wallet has no NFTs', async () => {
    mockSw((m) => (m.action === 'listNfts' ? { nfts: [] } : { success: true }));
    renderWithProviders(<NftPickerModal onConfirm={() => {}} onClose={() => {}} />);
    expect(await screen.findByTestId('nft-picker-empty')).toBeInTheDocument();
  });

  it('shows the error state + retry when the scan fails', async () => {
    mockSw((m) => (m.action === 'listNfts' ? { success: false, code: 'CHAIN_UNAVAILABLE' } : { success: true }));
    renderWithProviders(<NftPickerModal onConfirm={() => {}} onClose={() => {}} />);
    expect(await screen.findByTestId('nft-picker-error')).toBeInTheDocument();
  });

  it('multi-selects tiles, shows a live count, and "Add N selected" confirms exactly the chosen NFTs', async () => {
    mockSw((m) => (m.action === 'listNfts' ? { nfts: [NFT_A, NFT_B, NFT_C] } : { success: true }));
    const onConfirm = vi.fn();
    renderWithProviders(<NftPickerModal onConfirm={onConfirm} onClose={() => {}} />);
    await screen.findByTestId('nft-grid');

    expect(screen.getByTestId('nft-picker-count')).toHaveTextContent('0 selected');
    expect(screen.getByTestId('nft-picker-confirm')).toBeDisabled();

    fireEvent.click(screen.getByTestId(`nft-tile-${NFT_A.launcherId}`));
    fireEvent.click(screen.getByTestId(`nft-tile-${NFT_B.launcherId}`));
    expect(screen.getByTestId('nft-picker-count')).toHaveTextContent('2 selected');
    expect(screen.getByTestId('nft-picker-confirm')).toBeEnabled();

    fireEvent.click(screen.getByTestId('nft-picker-confirm'));
    expect(onConfirm).toHaveBeenCalledWith([NFT_A, NFT_B]);
  });

  it('select-all / clear act on every (filtered) NFT', async () => {
    mockSw((m) => (m.action === 'listNfts' ? { nfts: [NFT_A, NFT_B, NFT_C] } : { success: true }));
    renderWithProviders(<NftPickerModal onConfirm={() => {}} onClose={() => {}} />);
    await screen.findByTestId('nft-grid');

    fireEvent.click(screen.getByTestId('nft-picker-select-all'));
    expect(screen.getByTestId('nft-picker-count')).toHaveTextContent('3 selected');
    fireEvent.click(screen.getByTestId('nft-picker-select-clear'));
    expect(screen.getByTestId('nft-picker-count')).toHaveTextContent('0 selected');
  });

  it('search/filter narrows the grid to matching NFTs by id', async () => {
    mockSw((m) => (m.action === 'listNfts' ? { nfts: [NFT_A, NFT_B, NFT_C] } : { success: true }));
    renderWithProviders(<NftPickerModal onConfirm={() => {}} onClose={() => {}} />);
    await screen.findByTestId('nft-grid');

    fireEvent.change(screen.getByTestId('nft-picker-search'), { target: { value: NFT_A.launcherId.slice(0, 8) } });
    expect(screen.getByTestId(`nft-tile-${NFT_A.launcherId}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`nft-tile-${NFT_B.launcherId}`)).not.toBeInTheDocument();
    expect(screen.queryByTestId(`nft-tile-${NFT_C.launcherId}`)).not.toBeInTheDocument();
  });

  it('a search matching nothing shows a "no results" message, never the empty-wallet state', async () => {
    mockSw((m) => (m.action === 'listNfts' ? { nfts: [NFT_A] } : { success: true }));
    renderWithProviders(<NftPickerModal onConfirm={() => {}} onClose={() => {}} />);
    await screen.findByTestId('nft-grid');
    fireEvent.change(screen.getByTestId('nft-picker-search'), { target: { value: 'zzzz-no-match' } });
    expect(await screen.findByTestId('nft-picker-no-results')).toBeInTheDocument();
    expect(screen.queryByTestId('nft-picker-empty')).not.toBeInTheDocument();
  });

  it('paginates a large wallet with "Load more" so the grid never renders every tile at once', async () => {
    const many = manyNfts(40);
    mockSw((m) => (m.action === 'listNfts' ? { nfts: many } : { success: true }));
    renderWithProviders(<NftPickerModal onConfirm={() => {}} onClose={() => {}} />);
    await screen.findByTestId('nft-grid');

    const initialTiles = screen.getAllByRole('listitem').length;
    expect(initialTiles).toBeLessThan(40);
    expect(screen.getByTestId('nft-picker-load-more')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('nft-picker-load-more'));
    expect(screen.getAllByRole('listitem').length).toBeGreaterThan(initialTiles);
  });

  it('single-select mode (multiple=false) replaces the prior pick instead of adding to it', async () => {
    mockSw((m) => (m.action === 'listNfts' ? { nfts: [NFT_A, NFT_B] } : { success: true }));
    const onConfirm = vi.fn();
    renderWithProviders(<NftPickerModal multiple={false} onConfirm={onConfirm} onClose={() => {}} />);
    await screen.findByTestId('nft-grid');

    // no select-all/clear in single-select mode
    expect(screen.queryByTestId('nft-picker-select-all')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId(`nft-tile-${NFT_A.launcherId}`));
    expect(screen.getByTestId('nft-picker-count')).toHaveTextContent('1 selected');
    fireEvent.click(screen.getByTestId(`nft-tile-${NFT_B.launcherId}`));
    expect(screen.getByTestId('nft-picker-count')).toHaveTextContent('1 selected');

    fireEvent.click(screen.getByTestId('nft-picker-confirm'));
    expect(onConfirm).toHaveBeenCalledWith([NFT_B]);
  });

  it('pre-selects initialSelectedIds when reopened to change a pick', async () => {
    mockSw((m) => (m.action === 'listNfts' ? { nfts: [NFT_A, NFT_B] } : { success: true }));
    renderWithProviders(<NftPickerModal multiple={false} initialSelectedIds={[NFT_A.launcherId]} onConfirm={() => {}} onClose={() => {}} />);
    await screen.findByTestId('nft-grid');
    expect(screen.getByTestId('nft-picker-count')).toHaveTextContent('1 selected');
    expect(screen.getByTestId(`nft-select-${NFT_A.launcherId}`)).toHaveTextContent('✓');
  });

  it('Escape closes; Cancel closes without calling onConfirm', async () => {
    mockSw((m) => (m.action === 'listNfts' ? { nfts: [NFT_A] } : { success: true }));
    const onClose = vi.fn();
    const onConfirm = vi.fn();
    renderWithProviders(<NftPickerModal onConfirm={onConfirm} onClose={onClose} />);
    await screen.findByTestId('nft-grid');

    fireEvent.click(screen.getByTestId(`nft-tile-${NFT_A.launcherId}`));
    fireEvent.click(screen.getByTestId('nft-picker-cancel'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('a backdrop click closes; a click on the dialog itself does not', async () => {
    mockSw((m) => (m.action === 'listNfts' ? { nfts: [NFT_A] } : { success: true }));
    const onClose = vi.fn();
    renderWithProviders(<NftPickerModal onConfirm={() => {}} onClose={onClose} />);
    await screen.findByTestId('nft-grid');

    fireEvent.mouseDown(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(screen.getByTestId('nft-picker-modal'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('is a focus-trapped, labelled dialog with no WCAG violations', async () => {
    mockSw((m) => (m.action === 'listNfts' ? { nfts: [NFT_A] } : { success: true }));
    const { container } = renderWithProviders(<NftPickerModal onConfirm={() => {}} onClose={() => {}} />);
    await screen.findByTestId('nft-grid');
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName();
    expect((await axe(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
  });
});
