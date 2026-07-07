import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '@/test/harness';
import { TradePanel } from '@/features/wallet/custody/TradePanel';
import { custodyAssetBalances } from '@/features/wallet/custody/balances';
import { DIG_ASSET_ID } from '@/lib/links';

/** XCH + $DIG assets so the give/get pickers have two distinct legs. */
function twoAssets() {
  return custodyAssetBalances({ xch: 1_000_000_000_000, cats: { [DIG_ASSET_ID]: 5000 } }, []);
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

const OFFER = 'offer1qqqexampleofferstringqqq';
const SUMMARY = {
  offered: [{ asset: { kind: 'xch' as const }, amount: '100000000000' }],
  requested: [{ asset: { kind: 'cat' as const, assetId: DIG_ASSET_ID }, amount: '250', toPuzzleHashHex: 'ab' }],
};

/** A wallet-owned NFT fixture for the "offer an NFT" give-picker (#94). */
function nftFixture() {
  return {
    launcherId: 'ab'.repeat(32),
    coinId: 'cd'.repeat(32),
    p2PuzzleHash: 'ef'.repeat(32),
    collectionId: null,
    editionNumber: '1',
    editionTotal: '1',
    royaltyBasisPoints: 250,
    royaltyPuzzleHash: '00'.repeat(32),
    dataUris: ['https://example.test/1.png'],
    dataHash: null,
    metadataUris: [],
    metadataHash: null,
    licenseUris: [],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('TradePanel — surface tiering (#145)', () => {
  it('shows only an "open full screen" affordance on the popup surface — never the make/take forms', async () => {
    mockSw(() => ({ success: true }));
    renderWithProviders(<TradePanel assets={twoAssets()} full={false} />);
    expect(await screen.findByTestId('trade-open-fullscreen')).toBeInTheDocument();
    expect(screen.queryByTestId('trade-make-form')).not.toBeInTheDocument();
    expect(screen.queryByTestId('trade-mode-make')).not.toBeInTheDocument();
  });

  it('shows the full make/take UI on the fullscreen surface', async () => {
    mockSw(() => ({ success: true }));
    renderWithProviders(<TradePanel assets={twoAssets()} full />);
    expect(await screen.findByTestId('trade-mode-make')).toBeInTheDocument();
    expect(screen.queryByTestId('trade-open-fullscreen')).not.toBeInTheDocument();
  });
});

describe('TradePanel — make', () => {
  it('builds an offer and shows the shareable deal card', async () => {
    mockSw((m) => {
      if (m.action === 'makeOffer') return { offer: OFFER, offerSummary: SUMMARY };
      return { success: true };
    });
    renderWithProviders(<TradePanel assets={twoAssets()} full />);

    fireEvent.change(screen.getByTestId('trade-give-amount'), { target: { value: '0.1' } });
    fireEvent.change(screen.getByTestId('trade-get-amount'), { target: { value: '250' } });
    fireEvent.click(screen.getByTestId('trade-make-submit'));

    expect(await screen.findByTestId('trade-deal-card')).toBeInTheDocument();
    expect(screen.getByTestId('trade-offer-string')).toHaveValue(OFFER);
    // A QR renders for a short offer string.
    expect(screen.getByTestId('trade-qr')).toBeInTheDocument();
  });

  it('rejects trading an asset for itself', async () => {
    mockSw(() => ({ success: true }));
    renderWithProviders(<TradePanel assets={twoAssets()} full />);
    // Force both pickers to the same asset (index 0).
    fireEvent.change(screen.getByTestId('trade-get-asset'), { target: { value: '0' } });
    fireEvent.change(screen.getByTestId('trade-give-amount'), { target: { value: '1' } });
    fireEvent.change(screen.getByTestId('trade-get-amount'), { target: { value: '1' } });
    fireEvent.click(screen.getByTestId('trade-make-submit'));
    expect(await screen.findByTestId('trade-make-error')).toBeInTheDocument();
  });
});

describe('TradePanel — take', () => {
  it('paste → review → accept → confirm → sending → confirmed (with polling)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockSw((m) => {
      if (m.action === 'inspectOffer') return { offerSummary: SUMMARY };
      if (m.action === 'prepareTrade') return { pendingId: 'p1', offerSummary: SUMMARY };
      if (m.action === 'confirmTrade') return { spentCoinId: 'coin1' };
      if (m.action === 'sendStatus') return { confirmed: true };
      return { success: true };
    });
    renderWithProviders(<TradePanel assets={twoAssets()} full pollMs={50} />);

    fireEvent.click(screen.getByTestId('trade-mode-take'));
    fireEvent.change(screen.getByTestId('trade-take-input'), { target: { value: OFFER } });
    fireEvent.click(screen.getByTestId('trade-take-review-btn'));

    expect(await screen.findByTestId('trade-take-review')).toBeInTheDocument();
    expect(screen.getByTestId('trade-summary-get')).toHaveTextContent('XCH');

    fireEvent.click(screen.getByTestId('trade-take-accept'));
    expect(await screen.findByTestId('trade-take-confirm')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('trade-take-confirm'));

    expect(await screen.findByTestId('trade-sending')).toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(60);
    expect(await screen.findByTestId('trade-confirmed')).toBeInTheDocument();
  });

  it('rejects a non-offer string', async () => {
    mockSw(() => ({ success: true }));
    renderWithProviders(<TradePanel assets={twoAssets()} full />);
    fireEvent.click(screen.getByTestId('trade-mode-take'));
    fireEvent.change(screen.getByTestId('trade-take-input'), { target: { value: 'not-an-offer' } });
    fireEvent.click(screen.getByTestId('trade-take-review-btn'));
    expect(await screen.findByTestId('trade-take-error')).toBeInTheDocument();
  });

  it('surfaces a failed broadcast', async () => {
    mockSw((m) => {
      if (m.action === 'inspectOffer') return { offerSummary: SUMMARY };
      if (m.action === 'prepareTrade') return { pendingId: 'p1', offerSummary: SUMMARY };
      if (m.action === 'confirmTrade') return { success: false, code: 'PUSH_FAILED' };
      return { success: true };
    });
    renderWithProviders(<TradePanel assets={twoAssets()} full />);
    fireEvent.click(screen.getByTestId('trade-mode-take'));
    fireEvent.change(screen.getByTestId('trade-take-input'), { target: { value: OFFER } });
    fireEvent.click(screen.getByTestId('trade-take-review-btn'));
    fireEvent.click(await screen.findByTestId('trade-take-accept'));
    fireEvent.click(await screen.findByTestId('trade-take-confirm'));
    expect(await screen.findByTestId('trade-failed')).toBeInTheDocument();
  });

  it('drops an .offer file onto the dropzone and inspects it (#94)', async () => {
    mockSw((m) => (m.action === 'inspectOffer' ? { offerSummary: SUMMARY } : { success: true }));
    renderWithProviders(<TradePanel assets={twoAssets()} full />);
    fireEvent.click(screen.getByTestId('trade-mode-take'));
    const dropzone = screen.getByTestId('trade-take-dropzone');
    const file = new File([OFFER], 'my-trade.offer', { type: 'text/plain' });
    fireEvent.drop(dropzone, { dataTransfer: { files: [file] } });
    expect(await screen.findByTestId('trade-take-review')).toBeInTheDocument();
    expect(screen.getByTestId('trade-summary-get')).toHaveTextContent('XCH');
  });

  it('shows an error for a dropped file that is not an offer', async () => {
    mockSw(() => ({ success: true }));
    renderWithProviders(<TradePanel assets={twoAssets()} full />);
    fireEvent.click(screen.getByTestId('trade-mode-take'));
    const dropzone = screen.getByTestId('trade-take-dropzone');
    const file = new File(['not an offer'], 'notes.txt', { type: 'text/plain' });
    fireEvent.drop(dropzone, { dataTransfer: { files: [file] } });
    expect(await screen.findByTestId('trade-take-error')).toBeInTheDocument();
  });
});

describe('TradePanel — make an NFT (offering a self-custody singleton, #94)', () => {
  it('offers an owned NFT for XCH and shows the shareable deal card', async () => {
    let capturedOffered: unknown;
    mockSw((m) => {
      if (m.action === 'listNfts') return { nfts: [nftFixture()] };
      if (m.action === 'makeOffer') {
        capturedOffered = m.offered;
        return { offer: OFFER, offerSummary: SUMMARY };
      }
      return { success: true };
    });
    renderWithProviders(<TradePanel assets={twoAssets()} full />);

    fireEvent.click(screen.getByTestId('trade-give-kind-nft'));
    await screen.findByTestId('trade-give-nft');
    fireEvent.change(screen.getByTestId('trade-get-amount'), { target: { value: '250' } });
    fireEvent.click(screen.getByTestId('trade-make-submit'));

    expect(await screen.findByTestId('trade-deal-card')).toBeInTheDocument();
    expect(capturedOffered).toEqual({ asset: { kind: 'nft', launcherId: nftFixture().launcherId }, amount: '1' });
  });

  it('shows an empty state when the wallet holds no NFTs to offer', async () => {
    mockSw((m) => (m.action === 'listNfts' ? { nfts: [] } : { success: true }));
    renderWithProviders(<TradePanel assets={twoAssets()} full />);
    fireEvent.click(screen.getByTestId('trade-give-kind-nft'));
    expect(await screen.findByTestId('trade-give-nft-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('trade-give-nft')).not.toBeInTheDocument();
  });

  it('switches back to currency give mode', async () => {
    mockSw((m) => (m.action === 'listNfts' ? { nfts: [nftFixture()] } : { success: true }));
    renderWithProviders(<TradePanel assets={twoAssets()} full />);
    fireEvent.click(screen.getByTestId('trade-give-kind-nft'));
    await screen.findByTestId('trade-give-nft');
    fireEvent.click(screen.getByTestId('trade-give-kind-currency'));
    expect(screen.getByTestId('trade-give-asset')).toBeInTheDocument();
    expect(screen.queryByTestId('trade-give-nft')).not.toBeInTheDocument();
  });
});
