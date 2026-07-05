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

  it('offers a remote image as an external link (never embedded — CSP)', () => {
    mockSw(() => ({ success: true }));
    renderWithProviders(<NftDetail nft={nft({ dataUris: ['https://ipfs.test/i.png'] })} onBack={() => {}} />);
    expect(screen.queryByTestId('nft-image')).not.toBeInTheDocument();
    expect(screen.getByTestId('nft-view-image')).toHaveAttribute('href', 'https://ipfs.test/i.png');
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
});
