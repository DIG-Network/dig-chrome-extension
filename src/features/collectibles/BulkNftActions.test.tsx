import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { axe } from 'jest-axe';
import { renderWithProviders } from '@/test/harness';
import { BulkNftActions } from '@/features/collectibles/BulkNftActions';
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

const NFT_A = nft({ launcherId: 'aa'.repeat(32) });
const NFT_B = nft({ launcherId: 'bb'.repeat(32) });

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

describe('BulkNftActions — transfer (#171)', () => {
  it('shows the selected count in the title', () => {
    mockSw(() => ({ success: true }));
    renderWithProviders(<BulkNftActions nfts={[NFT_A, NFT_B]} mode="transfer" onDone={() => {}} />);
    expect(screen.getByTestId('bulk-transfer-form')).toHaveTextContent('Transfer 2 NFTs');
  });

  it('rejects an invalid recipient before building — never calls prepareNftBulkTransfer', async () => {
    const sw = mockSw(() => ({ success: true }));
    renderWithProviders(<BulkNftActions nfts={[NFT_A, NFT_B]} mode="transfer" onDone={() => {}} />);
    fireEvent.change(screen.getByTestId('bulk-transfer-recipient'), { target: { value: 'not-an-address' } });
    fireEvent.click(screen.getByTestId('bulk-transfer-review'));
    expect(await screen.findByTestId('bulk-transfer-error')).toBeInTheDocument();
    expect(sw).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'prepareNftBulkTransfer' }), expect.any(Function));
  });

  it('form → review → confirm → sending → confirmed builds ONE bundle for every selected launcherId', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const sw = mockSw((m) => {
      if (m.action === 'prepareNftBulkTransfer') {
        return { pendingId: 'p1', nftBulkSummary: { launcherIds: [NFT_A.launcherId, NFT_B.launcherId], recipientPuzzleHashHex: 'ef', fee: '0', coinCount: 2, isBurn: false } };
      }
      if (m.action === 'confirmNftBulkTransfer') return { spentCoinId: 'coin1' };
      if (m.action === 'sendStatus') return { confirmed: true };
      return { success: true };
    });
    const onDone = vi.fn();
    renderWithProviders(<BulkNftActions nfts={[NFT_A, NFT_B]} mode="transfer" onDone={onDone} pollMs={50} />);

    fireEvent.change(screen.getByTestId('bulk-transfer-recipient'), { target: { value: RECIPIENT } });
    fireEvent.click(screen.getByTestId('bulk-transfer-review'));

    expect(await screen.findByTestId('bulk-transfer-review-panel')).toBeInTheDocument();
    expect(screen.getByTestId('bulk-transfer-review-recipient')).toHaveTextContent(RECIPIENT);
    expect(screen.getByTestId('bulk-transfer-review-list')).toHaveTextContent(NFT_A.launcherId.slice(0, 6));
    expect(screen.getByTestId('bulk-transfer-review-list')).toHaveTextContent(NFT_B.launcherId.slice(0, 6));

    fireEvent.click(screen.getByTestId('bulk-transfer-confirm'));
    expect(await screen.findByTestId('bulk-transfer-sending')).toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(60);
    expect(await screen.findByTestId('bulk-transfer-confirmed')).toBeInTheDocument();

    expect(sw).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'prepareNftBulkTransfer', launcherIds: [NFT_A.launcherId, NFT_B.launcherId], recipient: RECIPIENT }),
      expect.any(Function),
    );
    // onDone is offered via the terminal "Done" button, not auto-invoked.
    expect(onDone).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('bulk-transfer-done'));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('shows the terminal failure state when the broadcast is rejected', async () => {
    mockSw((m) => {
      if (m.action === 'prepareNftBulkTransfer') return { pendingId: 'p1', nftBulkSummary: { launcherIds: [NFT_A.launcherId], recipientPuzzleHashHex: 'ef', fee: '0', coinCount: 1, isBurn: false } };
      if (m.action === 'confirmNftBulkTransfer') return { success: false, code: 'PUSH_FAILED' };
      return { success: true };
    });
    renderWithProviders(<BulkNftActions nfts={[NFT_A]} mode="transfer" onDone={() => {}} />);
    fireEvent.change(screen.getByTestId('bulk-transfer-recipient'), { target: { value: RECIPIENT } });
    fireEvent.click(screen.getByTestId('bulk-transfer-review'));
    fireEvent.click(await screen.findByTestId('bulk-transfer-confirm'));
    expect(await screen.findByTestId('bulk-transfer-failed')).toBeInTheDocument();
  });

  it('cancel returns via onDone without ever preparing anything', () => {
    const sw = mockSw(() => ({ success: true }));
    const onDone = vi.fn();
    renderWithProviders(<BulkNftActions nfts={[NFT_A]} mode="transfer" onDone={onDone} />);
    fireEvent.click(screen.getByTestId('bulk-transfer-cancel'));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(sw).not.toHaveBeenCalled();
  });

  it('has no WCAG violations (transfer form)', async () => {
    mockSw(() => ({ success: true }));
    const { container } = renderWithProviders(<BulkNftActions nfts={[NFT_A, NFT_B]} mode="transfer" onDone={() => {}} />);
    expect((await axe(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
  });
});

describe('BulkNftActions — destructive burn (#171)', () => {
  it('shows the DESTRUCTIVE warning and disables Review until the user types BURN exactly', async () => {
    const sw = mockSw(() => ({ success: true }));
    renderWithProviders(<BulkNftActions nfts={[NFT_A, NFT_B]} mode="burn" onDone={() => {}} />);
    expect(screen.getByTestId('bulk-burn-warning')).toHaveTextContent('permanent and cannot be undone');
    expect(screen.getByTestId('bulk-burn-review')).toBeDisabled();

    fireEvent.change(screen.getByTestId('bulk-burn-confirm-text'), { target: { value: 'not it' } });
    expect(screen.getByTestId('bulk-burn-confirm-mismatch')).toBeInTheDocument();
    expect(screen.getByTestId('bulk-burn-review')).toBeDisabled();

    fireEvent.change(screen.getByTestId('bulk-burn-confirm-text'), { target: { value: 'BURN' } });
    expect(screen.queryByTestId('bulk-burn-confirm-mismatch')).not.toBeInTheDocument();
    expect(screen.getByTestId('bulk-burn-review')).not.toBeDisabled();

    // Clicking Review before typing BURN must NEVER reach prepareNftBulkBurn — re-verify from empty.
    fireEvent.change(screen.getByTestId('bulk-burn-confirm-text'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('bulk-burn-review'));
    expect(sw).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'prepareNftBulkBurn' }), expect.any(Function));
  });

  it('warn → review → confirm → sending → confirmed burns to the well-known destination — confirmNftBulkBurn is NEVER auto-invoked', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const sw = mockSw((m) => {
      if (m.action === 'prepareNftBulkBurn') {
        return { pendingId: 'p1', nftBulkSummary: { launcherIds: [NFT_A.launcherId, NFT_B.launcherId], recipientPuzzleHashHex: '0'.repeat(60) + 'dead', fee: '0', coinCount: 2, isBurn: true } };
      }
      if (m.action === 'confirmNftBulkBurn') return { spentCoinId: 'coin1' };
      if (m.action === 'sendStatus') return { confirmed: true };
      return { success: true };
    });
    renderWithProviders(<BulkNftActions nfts={[NFT_A, NFT_B]} mode="burn" onDone={() => {}} pollMs={50} />);

    fireEvent.change(screen.getByTestId('bulk-burn-confirm-text'), { target: { value: 'BURN' } });
    fireEvent.click(screen.getByTestId('bulk-burn-review'));

    expect(await screen.findByTestId('bulk-burn-review-panel')).toBeInTheDocument();
    expect(screen.getByTestId('bulk-burn-review-destination')).toHaveTextContent('unspendable');
    // confirmNftBulkBurn must not have fired merely from reaching the review screen.
    expect(sw).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'confirmNftBulkBurn' }), expect.any(Function));

    fireEvent.click(screen.getByTestId('bulk-burn-confirm'));
    expect(await screen.findByTestId('bulk-burn-sending')).toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(60);
    expect(await screen.findByTestId('bulk-burn-confirmed')).toBeInTheDocument();

    expect(sw).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'prepareNftBulkBurn', launcherIds: [NFT_A.launcherId, NFT_B.launcherId] }),
      expect.any(Function),
    );
    expect(sw).toHaveBeenCalledWith(expect.objectContaining({ action: 'confirmNftBulkBurn', pendingId: 'p1' }), expect.any(Function));
  });

  it('shows the terminal failure state when the burn broadcast is rejected', async () => {
    mockSw((m) => {
      if (m.action === 'prepareNftBulkBurn') return { pendingId: 'p1', nftBulkSummary: { launcherIds: [NFT_A.launcherId], recipientPuzzleHashHex: 'dead', fee: '0', coinCount: 1, isBurn: true } };
      if (m.action === 'confirmNftBulkBurn') return { success: false, code: 'PUSH_FAILED' };
      return { success: true };
    });
    renderWithProviders(<BulkNftActions nfts={[NFT_A]} mode="burn" onDone={() => {}} />);
    fireEvent.change(screen.getByTestId('bulk-burn-confirm-text'), { target: { value: 'BURN' } });
    fireEvent.click(screen.getByTestId('bulk-burn-review'));
    fireEvent.click(await screen.findByTestId('bulk-burn-confirm'));
    expect(await screen.findByTestId('bulk-burn-failed')).toBeInTheDocument();
  });

  it('cancel returns via onDone without ever preparing the burn', () => {
    const sw = mockSw(() => ({ success: true }));
    const onDone = vi.fn();
    renderWithProviders(<BulkNftActions nfts={[NFT_A]} mode="burn" onDone={onDone} />);
    fireEvent.click(screen.getByTestId('bulk-burn-cancel'));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(sw).not.toHaveBeenCalled();
  });

  it('has no WCAG violations (burn warning form)', async () => {
    mockSw(() => ({ success: true }));
    const { container } = renderWithProviders(<BulkNftActions nfts={[NFT_A, NFT_B]} mode="burn" onDone={() => {}} />);
    expect((await axe(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
  });
});
