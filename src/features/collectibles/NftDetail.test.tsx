import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { axe } from 'jest-axe';
import { renderWithProviders } from '@/test/harness';
import { NftDetail } from '@/features/collectibles/NftDetail';
import type { WalletNft } from '@/offscreen/nfts';
import golden from '@/lib/keystore/derive.golden.json';

const RECIPIENT = golden.unhardened[0].address;

function nft(over: Partial<WalletNft> = {}): WalletNft {
  return {
    launcherId: 'ab'.repeat(32),
    coinId: 'cd'.repeat(32),
    p2PuzzleHash: 'ef'.repeat(32),
    collectionId: null,
    editionNumber: '1',
    editionTotal: '1',
    royaltyBasisPoints: 300,
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

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('NftDetail', () => {
  it('shows on-chain data: launcher id, royalty, edition, monogram placeholder', () => {
    mockSw(() => ({ success: true }));
    renderWithProviders(<NftDetail nft={nft({ editionNumber: '2', editionTotal: '10' })} onBack={() => {}} />);
    expect(screen.getByTestId('nft-launcher-id')).toHaveTextContent('ab'.repeat(32));
    expect(screen.getByTestId('nft-royalty')).toHaveTextContent('3%');
    expect(screen.getByTestId('nft-edition')).toHaveTextContent('2 / 10');
    expect(screen.getByTestId('nft-monogram')).toBeInTheDocument();
  });

  it('embeds a data: image and links out to remote metadata', () => {
    mockSw(() => ({ success: true }));
    renderWithProviders(
      <NftDetail nft={nft({ dataUris: ['data:image/png;base64,AAA'], metadataUris: ['https://ex.test/m.json'] })} onBack={() => {}} />,
    );
    expect(screen.getByTestId('nft-image')).toHaveAttribute('src', 'data:image/png;base64,AAA');
    expect(screen.getByTestId('nft-view-metadata')).toHaveAttribute('href', 'https://ex.test/m.json');
  });

  it('embeds a remote https image (#150) and also offers it as an external link', () => {
    mockSw(() => ({ success: true }));
    renderWithProviders(<NftDetail nft={nft({ dataUris: ['https://ipfs.test/i.png'] })} onBack={() => {}} />);
    expect(screen.getByTestId('nft-image')).toHaveAttribute('src', 'https://ipfs.test/i.png');
    expect(screen.getByTestId('nft-view-image')).toHaveAttribute('href', 'https://ipfs.test/i.png');
  });

  it('gateway-rewrites an ipfs:// image so it embeds + links via a fetchable https URL', () => {
    mockSw(() => ({ success: true }));
    renderWithProviders(<NftDetail nft={nft({ dataUris: ['ipfs://cid/i.png'] })} onBack={() => {}} />);
    expect(screen.getByTestId('nft-image')).toHaveAttribute('src', 'https://ipfs.io/ipfs/cid/i.png');
    expect(screen.getByTestId('nft-view-image')).toHaveAttribute('href', 'https://ipfs.io/ipfs/cid/i.png');
  });

  it('falls back to the monogram when a remote image fails to load', () => {
    mockSw(() => ({ success: true }));
    renderWithProviders(<NftDetail nft={nft({ dataUris: ['https://dead.test/i.png'] })} onBack={() => {}} />);
    const img = screen.getByTestId('nft-image');
    expect(screen.queryByTestId('nft-monogram')).not.toBeInTheDocument();
    fireEvent.error(img);
    expect(screen.queryByTestId('nft-image')).not.toBeInTheDocument();
    expect(screen.getByTestId('nft-monogram')).toBeInTheDocument();
  });

  it('rejects an invalid recipient before building', async () => {
    const sw = mockSw(() => ({ success: true }));
    renderWithProviders(<NftDetail nft={nft()} onBack={() => {}} />);
    fireEvent.click(screen.getByTestId('nft-transfer-open'));
    fireEvent.change(screen.getByTestId('nft-transfer-recipient'), { target: { value: 'not-an-address' } });
    fireEvent.click(screen.getByTestId('nft-transfer-review'));
    expect(await screen.findByTestId('nft-transfer-error')).toBeInTheDocument();
    expect(sw).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'prepareNftTransfer' }), expect.any(Function));
  });

  it('form → review → confirm → sending → confirmed (happy path with polling)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const sw = mockSw((m) => {
      if (m.action === 'prepareNftTransfer') return { pendingId: 'p1', nftSummary: { launcherId: nft().launcherId, recipientPuzzleHashHex: 'ef', fee: '0', coinCount: 1 } };
      if (m.action === 'confirmNftTransfer') return { spentCoinId: 'coin1' };
      if (m.action === 'sendStatus') return { confirmed: true };
      return { success: true };
    });
    renderWithProviders(<NftDetail nft={nft()} onBack={() => {}} pollMs={50} />);

    fireEvent.click(screen.getByTestId('nft-transfer-open'));
    fireEvent.change(screen.getByTestId('nft-transfer-recipient'), { target: { value: RECIPIENT } });
    fireEvent.click(screen.getByTestId('nft-transfer-review'));

    expect(await screen.findByTestId('nft-transfer-review-panel')).toBeInTheDocument();
    expect(screen.getByTestId('nft-review-recipient')).toHaveTextContent(RECIPIENT);

    fireEvent.click(screen.getByTestId('nft-transfer-confirm'));
    expect(await screen.findByTestId('nft-transfer-sending')).toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(60);
    expect(await screen.findByTestId('nft-transfer-confirmed')).toBeInTheDocument();
    expect(sw).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'prepareNftTransfer', launcherId: nft().launcherId, recipient: RECIPIENT }),
      expect.any(Function),
    );
  });

  it('shows the terminal failure state when the broadcast is rejected', async () => {
    mockSw((m) => {
      if (m.action === 'prepareNftTransfer') return { pendingId: 'p1', nftSummary: { launcherId: nft().launcherId, recipientPuzzleHashHex: 'ef', fee: '0', coinCount: 1 } };
      if (m.action === 'confirmNftTransfer') return { success: false, code: 'PUSH_FAILED' };
      return { success: true };
    });
    renderWithProviders(<NftDetail nft={nft()} onBack={() => {}} />);
    fireEvent.click(screen.getByTestId('nft-transfer-open'));
    fireEvent.change(screen.getByTestId('nft-transfer-recipient'), { target: { value: RECIPIENT } });
    fireEvent.click(screen.getByTestId('nft-transfer-review'));
    fireEvent.click(await screen.findByTestId('nft-transfer-confirm'));
    expect(await screen.findByTestId('nft-transfer-failed')).toBeInTheDocument();
  });

  it('has no WCAG violations (detail view)', async () => {
    mockSw(() => ({ success: true }));
    const { container } = renderWithProviders(<NftDetail nft={nft({ metadataUris: ['https://ex.test/m.json'] })} onBack={() => {}} />);
    expect((await axe(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
  });

  it('surfaces a build failure as an inline error', async () => {
    mockSw((m) => (m.action === 'prepareNftTransfer' ? { success: false, code: 'NFT_NOT_FOUND' } : { success: true }));
    renderWithProviders(<NftDetail nft={nft()} onBack={() => {}} />);
    fireEvent.click(screen.getByTestId('nft-transfer-open'));
    fireEvent.change(screen.getByTestId('nft-transfer-recipient'), { target: { value: RECIPIENT } });
    fireEvent.click(screen.getByTestId('nft-transfer-review'));
    expect(await screen.findByTestId('nft-transfer-error')).toBeInTheDocument();
  });

  const DID = { launcherId: 'aa'.repeat(32), coinId: 'bb'.repeat(32), p2PuzzleHash: 'cc'.repeat(32), recoveryListHash: null, numVerificationsRequired: '1', profileName: 'Alice' };

  it('offers "Assign DID owner" on the fullscreen surface only (#93/#145)', () => {
    mockSw(() => ({ success: true }));
    renderWithProviders(<NftDetail nft={nft()} isFull onBack={() => {}} />);
    expect(screen.getByTestId('nft-assign-open')).toBeInTheDocument();
    expect(screen.queryByTestId('nft-assign-fullscreen')).not.toBeInTheDocument();
  });

  it('offers only an "open full screen" affordance for assignment on the popup surface', () => {
    mockSw(() => ({ success: true }));
    renderWithProviders(<NftDetail nft={nft()} isFull={false} onBack={() => {}} />);
    expect(screen.getByTestId('nft-assign-fullscreen')).toBeInTheDocument();
    expect(screen.queryByTestId('nft-assign-open')).not.toBeInTheDocument();
  });

  it('requires a DID to be picked before building', async () => {
    const sw = mockSw((m) => (m.action === 'listDids' ? { dids: [DID] } : { success: true }));
    renderWithProviders(<NftDetail nft={nft()} isFull onBack={() => {}} />);
    fireEvent.click(screen.getByTestId('nft-assign-open'));
    expect(await screen.findByTestId(`nft-assign-did-${DID.launcherId}`)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('nft-assign-review'));
    expect(await screen.findByTestId('nft-assign-error')).toBeInTheDocument();
    expect(sw).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'prepareNftDidAssign' }), expect.any(Function));
  });

  it('shows an empty state when the wallet holds no DIDs', async () => {
    mockSw((m) => (m.action === 'listDids' ? { dids: [] } : { success: true }));
    renderWithProviders(<NftDetail nft={nft()} isFull onBack={() => {}} />);
    fireEvent.click(screen.getByTestId('nft-assign-open'));
    expect(await screen.findByTestId('nft-assign-dids-empty')).toBeInTheDocument();
  });

  it('assign: pick → review → confirm → sending → confirmed (happy path with polling)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const sw = mockSw((m) => {
      if (m.action === 'listDids') return { dids: [DID] };
      if (m.action === 'prepareNftDidAssign') return { pendingId: 'p1', nftDidAssignSummary: { nftLauncherId: nft().launcherId, didLauncherId: DID.launcherId, fee: '0', coinCount: 2 } };
      if (m.action === 'confirmNftDidAssign') return { spentCoinId: 'coin1' };
      if (m.action === 'sendStatus') return { confirmed: true };
      return { success: true };
    });
    renderWithProviders(<NftDetail nft={nft()} isFull onBack={() => {}} pollMs={50} />);

    fireEvent.click(screen.getByTestId('nft-assign-open'));
    fireEvent.click(await screen.findByTestId(`nft-assign-did-${DID.launcherId}`));
    fireEvent.click(screen.getByTestId('nft-assign-review'));

    expect(await screen.findByTestId('nft-assign-review-panel')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('nft-assign-confirm'));
    expect(await screen.findByTestId('nft-assign-sending')).toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(60);
    expect(await screen.findByTestId('nft-assign-confirmed')).toBeInTheDocument();
    expect(sw).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'prepareNftDidAssign', launcherId: nft().launcherId, didLauncherId: DID.launcherId }),
      expect.any(Function),
    );
  });

  it('shows the terminal failure state when the assignment broadcast is rejected', async () => {
    mockSw((m) => {
      if (m.action === 'listDids') return { dids: [DID] };
      if (m.action === 'prepareNftDidAssign') return { pendingId: 'p1', nftDidAssignSummary: { nftLauncherId: nft().launcherId, didLauncherId: DID.launcherId, fee: '0', coinCount: 2 } };
      if (m.action === 'confirmNftDidAssign') return { success: false, code: 'PUSH_FAILED' };
      return { success: true };
    });
    renderWithProviders(<NftDetail nft={nft()} isFull onBack={() => {}} />);
    fireEvent.click(screen.getByTestId('nft-assign-open'));
    fireEvent.click(await screen.findByTestId(`nft-assign-did-${DID.launcherId}`));
    fireEvent.click(screen.getByTestId('nft-assign-review'));
    fireEvent.click(await screen.findByTestId('nft-assign-confirm'));
    expect(await screen.findByTestId('nft-assign-failed')).toBeInTheDocument();
  });
});
