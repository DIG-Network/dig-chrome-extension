import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { axe } from 'jest-axe';
import { renderWithProviders } from '@/test/harness';
import { MintNft } from '@/features/collectibles/MintNft';
import type { NftMintSummary } from '@/offscreen/nfts';

const MEDIA = 'https://example.test/img.png';
const LAUNCHER = 'ab'.repeat(32);

function summary(over: Partial<NftMintSummary> = {}): NftMintSummary {
  return {
    launcherId: LAUNCHER,
    dataUris: [MEDIA],
    metadataUris: [],
    licenseUris: [],
    editionNumber: '1',
    editionTotal: '1',
    royaltyBasisPoints: 250,
    royaltyPuzzleHashHex: 'ef'.repeat(32),
    fee: '0',
    coinCount: 1,
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

describe('MintNft', () => {
  it('requires a media URL before building (no prepare call on empty form)', async () => {
    const sw = mockSw(() => ({ success: true }));
    renderWithProviders(<MintNft onDone={() => {}} />);
    fireEvent.click(screen.getByTestId('mint-review'));
    expect(await screen.findByTestId('mint-media-error')).toBeInTheDocument();
    expect(sw).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'prepareNftMint' }), expect.any(Function));
  });

  it('rejects a malformed royalty before building', async () => {
    const sw = mockSw(() => ({ success: true }));
    renderWithProviders(<MintNft onDone={() => {}} />);
    fireEvent.change(screen.getByTestId('mint-media'), { target: { value: MEDIA } });
    fireEvent.change(screen.getByTestId('mint-royalty'), { target: { value: '200' } });
    fireEvent.click(screen.getByTestId('mint-review'));
    expect(await screen.findByTestId('mint-royalty-error')).toBeInTheDocument();
    expect(sw).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'prepareNftMint' }), expect.any(Function));
  });

  it('form → review shows the decoded summary (media + royalty + fee)', async () => {
    mockSw((m) => {
      if (m.action === 'prepareNftMint') return { pendingId: 'p1', launcherId: LAUNCHER, nftMintSummary: summary() };
      return { success: true };
    });
    renderWithProviders(<MintNft onDone={() => {}} />);
    fireEvent.change(screen.getByTestId('mint-media'), { target: { value: MEDIA } });
    fireEvent.change(screen.getByTestId('mint-royalty'), { target: { value: '2.5' } });
    fireEvent.click(screen.getByTestId('mint-review'));

    expect(await screen.findByTestId('mint-review-panel')).toBeInTheDocument();
    expect(screen.getByTestId('mint-review-media')).toHaveTextContent(MEDIA);
    expect(screen.getByTestId('mint-review-royalty')).toHaveTextContent('2.5%');
  });

  it('review → confirm → sending → confirmed (happy path with polling)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const sw = mockSw((m) => {
      if (m.action === 'prepareNftMint') return { pendingId: 'p1', launcherId: LAUNCHER, nftMintSummary: summary() };
      if (m.action === 'confirmNftMint') return { spentCoinId: 'coin1' };
      if (m.action === 'sendStatus') return { confirmed: true };
      return { success: true };
    });
    renderWithProviders(<MintNft onDone={() => {}} pollMs={50} />);

    fireEvent.change(screen.getByTestId('mint-media'), { target: { value: MEDIA } });
    fireEvent.click(screen.getByTestId('mint-review'));
    fireEvent.click(await screen.findByTestId('mint-confirm'));

    expect(await screen.findByTestId('mint-sending')).toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(60);
    expect(await screen.findByTestId('mint-confirmed')).toBeInTheDocument();
    expect(screen.getByTestId('mint-launcher-id')).toHaveTextContent(LAUNCHER);
    // The mint request carried the built wire params (media URI).
    expect(sw).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'prepareNftMint', nftMint: expect.objectContaining({ dataUris: [MEDIA] }) }),
      expect.any(Function),
    );
  });

  it('shows the terminal failure state when the broadcast is rejected', async () => {
    mockSw((m) => {
      if (m.action === 'prepareNftMint') return { pendingId: 'p1', launcherId: LAUNCHER, nftMintSummary: summary() };
      if (m.action === 'confirmNftMint') return { success: false, code: 'PUSH_FAILED' };
      return { success: true };
    });
    renderWithProviders(<MintNft onDone={() => {}} />);
    fireEvent.change(screen.getByTestId('mint-media'), { target: { value: MEDIA } });
    fireEvent.click(screen.getByTestId('mint-review'));
    fireEvent.click(await screen.findByTestId('mint-confirm'));
    expect(await screen.findByTestId('mint-failed')).toBeInTheDocument();
  });

  it('surfaces a build failure as an inline error', async () => {
    mockSw((m) => (m.action === 'prepareNftMint' ? { success: false, code: 'NO_XCH_COINS' } : { success: true }));
    renderWithProviders(<MintNft onDone={() => {}} />);
    fireEvent.change(screen.getByTestId('mint-media'), { target: { value: MEDIA } });
    fireEvent.click(screen.getByTestId('mint-review'));
    expect(await screen.findByTestId('mint-build-error')).toBeInTheDocument();
  });

  it('has no WCAG violations (mint form)', async () => {
    mockSw(() => ({ success: true }));
    const { container } = renderWithProviders(<MintNft onDone={() => {}} />);
    expect((await axe(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
  });
});
