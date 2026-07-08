import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '@/test/harness';
import { TradePanel } from '@/features/wallet/custody/TradePanel';
import { custodyAssetBalances } from '@/features/wallet/custody/balances';
import { DIG_ASSET_ID } from '@/lib/links';
import { nftDisplayName } from '@/features/collectibles/nftDisplay';

/** XCH + $DIG assets so the give/get pickers have two distinct legs. */
function twoAssets() {
  return custodyAssetBalances({ xch: 1_000_000_000_000, cats: { [DIG_ASSET_ID]: 5000 } }, []);
}

/** XCH + $DIG + a second CAT (#100 — multi-asset tests need a 3rd distinct asset so a give leg and
 * TWO requested legs can each name a different asset with none overlapping). */
const OTHER_CAT = 'ee'.repeat(32);
function threeAssets() {
  return custodyAssetBalances({ xch: 1_000_000_000_000, cats: { [DIG_ASSET_ID]: 5000, [OTHER_CAT]: 900 } }, []);
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

/** A wallet-owned NFT fixture for the "offer an NFT" give-picker (#94, fullscreen-only per #169). */
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

describe('TradePanel — surface tiering (#169 refines #145: basic maker/taker now lives in the popup)', () => {
  it('the popup surface shows a WORKING basic make/take surface — mode tabs + forms, not a redirect card', async () => {
    mockSw(() => ({ success: true }));
    renderWithProviders(<TradePanel assets={twoAssets()} full={false} />);
    expect(await screen.findByTestId('trade-mode-make')).toBeInTheDocument();
    expect(screen.getByTestId('trade-mode-take')).toBeInTheDocument();
    expect(screen.getByTestId('trade-make-form')).toBeInTheDocument();
  });

  it('#101: an "Offers" mode tab switches to the local made-offers log', async () => {
    mockSw((m) => (m.action === 'getOffers' ? { offers: [] } : { success: true }));
    renderWithProviders(<TradePanel assets={twoAssets()} full />);
    fireEvent.click(await screen.findByTestId('trade-mode-offers'));
    expect(await screen.findByTestId('offers-panel')).toBeInTheDocument();
  });

  it('the popup surface still offers an explicit "open full screen" link for advanced options', async () => {
    mockSw(() => ({ success: true }));
    renderWithProviders(<TradePanel assets={twoAssets()} full={false} />);
    expect(await screen.findByTestId('trade-open-fullscreen')).toBeInTheDocument();
  });

  it('the fullscreen surface has no "open full screen" link (already full)', async () => {
    mockSw(() => ({ success: true }));
    renderWithProviders(<TradePanel assets={twoAssets()} full />);
    expect(await screen.findByTestId('trade-mode-make')).toBeInTheDocument();
    expect(screen.queryByTestId('trade-open-fullscreen')).not.toBeInTheDocument();
  });

  it('the popup Make form hides the NFT give-kind toggle (advanced, #169) — currency only', async () => {
    mockSw(() => ({ success: true }));
    renderWithProviders(<TradePanel assets={twoAssets()} full={false} />);
    await screen.findByTestId('trade-make-form');
    expect(screen.queryByTestId('trade-give-kind-currency')).not.toBeInTheDocument();
    expect(screen.queryByTestId('trade-give-kind-nft')).not.toBeInTheDocument();
    // The currency give picker itself is still there — basic make works.
    expect(screen.getByTestId('trade-give-asset')).toBeInTheDocument();
  });

  it('the fullscreen Make form shows the NFT give-kind toggle', async () => {
    mockSw(() => ({ success: true }));
    renderWithProviders(<TradePanel assets={twoAssets()} full />);
    expect(await screen.findByTestId('trade-give-kind-currency')).toBeInTheDocument();
    expect(screen.getByTestId('trade-give-kind-nft')).toBeInTheDocument();
  });
});

describe('TradePanel — make (guided steps: choose → review → create, #169 clarity redesign)', () => {
  it('choosing give/get advances to a "You give / You get" review before building the offer', async () => {
    mockSw((m) => (m.action === 'makeOffer' ? { offer: OFFER, offerSummary: SUMMARY } : { success: true }));
    renderWithProviders(<TradePanel assets={twoAssets()} full />);

    fireEvent.change(screen.getByTestId('trade-give-amount'), { target: { value: '0.1' } });
    fireEvent.change(screen.getByTestId('trade-get-amount'), { target: { value: '250' } });
    fireEvent.click(screen.getByTestId('trade-make-continue'));

    expect(await screen.findByTestId('trade-make-review')).toBeInTheDocument();
    expect(screen.getByTestId('trade-make-review-give')).toHaveTextContent('0.1');
    expect(screen.getByTestId('trade-make-review-get')).toHaveTextContent('250');

    fireEvent.click(screen.getByTestId('trade-make-review-confirm'));
    expect(await screen.findByTestId('trade-deal-card')).toBeInTheDocument();
    expect(screen.getByTestId('trade-offer-string')).toHaveValue(OFFER);
    expect(screen.getByTestId('trade-qr')).toBeInTheDocument();
  });

  it('the review step can go back to the form to change the picks', async () => {
    mockSw(() => ({ success: true }));
    renderWithProviders(<TradePanel assets={twoAssets()} full />);
    fireEvent.change(screen.getByTestId('trade-give-amount'), { target: { value: '0.1' } });
    fireEvent.change(screen.getByTestId('trade-get-amount'), { target: { value: '250' } });
    fireEvent.click(screen.getByTestId('trade-make-continue'));
    await screen.findByTestId('trade-make-review');

    fireEvent.click(screen.getByTestId('trade-make-review-back'));
    expect(await screen.findByTestId('trade-make-form')).toBeInTheDocument();
  });

  it('rejects trading an asset for itself before reaching review', async () => {
    mockSw(() => ({ success: true }));
    renderWithProviders(<TradePanel assets={twoAssets()} full />);
    fireEvent.change(screen.getByTestId('trade-get-asset'), { target: { value: '0' } });
    fireEvent.change(screen.getByTestId('trade-give-amount'), { target: { value: '1' } });
    fireEvent.change(screen.getByTestId('trade-get-amount'), { target: { value: '1' } });
    fireEvent.click(screen.getByTestId('trade-make-continue'));
    expect(await screen.findByTestId('trade-make-error')).toBeInTheDocument();
    expect(screen.queryByTestId('trade-make-review')).not.toBeInTheDocument();
  });

  it('a build failure at the review step surfaces an inline error and stays reviewable', async () => {
    mockSw((m) => (m.action === 'makeOffer' ? { success: false, code: 'BUILD_FAILED' } : { success: true }));
    renderWithProviders(<TradePanel assets={twoAssets()} full />);
    fireEvent.change(screen.getByTestId('trade-give-amount'), { target: { value: '0.1' } });
    fireEvent.change(screen.getByTestId('trade-get-amount'), { target: { value: '250' } });
    fireEvent.click(screen.getByTestId('trade-make-continue'));
    await screen.findByTestId('trade-make-review');
    fireEvent.click(screen.getByTestId('trade-make-review-confirm'));
    expect(await screen.findByTestId('trade-make-error')).toBeInTheDocument();
    expect(screen.getByTestId('trade-make-review')).toBeInTheDocument();
  });
});

describe('TradePanel — popup basic make (#169: a simple currency-for-currency offer, in the compact surface)', () => {
  it('builds an offer end-to-end from the compact popup surface', async () => {
    mockSw((m) => (m.action === 'makeOffer' ? { offer: OFFER, offerSummary: SUMMARY } : { success: true }));
    renderWithProviders(<TradePanel assets={twoAssets()} full={false} />);

    fireEvent.change(screen.getByTestId('trade-give-amount'), { target: { value: '0.1' } });
    fireEvent.change(screen.getByTestId('trade-get-amount'), { target: { value: '250' } });
    fireEvent.click(screen.getByTestId('trade-make-continue'));
    expect(await screen.findByTestId('trade-make-review')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('trade-make-review-confirm'));

    expect(await screen.findByTestId('trade-deal-card')).toBeInTheDocument();
    expect(screen.getByTestId('trade-offer-string')).toHaveValue(OFFER);
  });
});

describe('TradePanel — popup basic take (#169: paste/drag → give/get → take, in the compact surface)', () => {
  it('paste → review → accept → confirm → sending → confirmed (with polling) from the compact popup', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockSw((m) => {
      if (m.action === 'inspectOffer') return { offerSummary: SUMMARY };
      if (m.action === 'prepareTrade') return { pendingId: 'p1', offerSummary: SUMMARY };
      if (m.action === 'confirmTrade') return { spentCoinId: 'coin1' };
      if (m.action === 'sendStatus') return { confirmed: true };
      return { success: true };
    });
    renderWithProviders(<TradePanel assets={twoAssets()} full={false} pollMs={50} />);

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

  it('drops an .offer file onto the dropzone from the compact popup (#94 accept path, reused)', async () => {
    mockSw((m) => (m.action === 'inspectOffer' ? { offerSummary: SUMMARY } : { success: true }));
    renderWithProviders(<TradePanel assets={twoAssets()} full={false} />);
    fireEvent.click(screen.getByTestId('trade-mode-take'));
    const dropzone = screen.getByTestId('trade-take-dropzone');
    const file = new File([OFFER], 'my-trade.offer', { type: 'text/plain' });
    fireEvent.drop(dropzone, { dataTransfer: { files: [file] } });
    expect(await screen.findByTestId('trade-take-review')).toBeInTheDocument();
    expect(screen.getByTestId('trade-summary-get')).toHaveTextContent('XCH');
  });

  it('rejects a non-offer string', async () => {
    mockSw(() => ({ success: true }));
    renderWithProviders(<TradePanel assets={twoAssets()} full={false} />);
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
    renderWithProviders(<TradePanel assets={twoAssets()} full={false} />);
    fireEvent.click(screen.getByTestId('trade-mode-take'));
    fireEvent.change(screen.getByTestId('trade-take-input'), { target: { value: OFFER } });
    fireEvent.click(screen.getByTestId('trade-take-review-btn'));
    fireEvent.click(await screen.findByTestId('trade-take-accept'));
    fireEvent.click(await screen.findByTestId('trade-take-confirm'));
    expect(await screen.findByTestId('trade-failed')).toBeInTheDocument();
  });
});

describe('TradePanel — make an NFT (offering a self-custody singleton, #94 — fullscreen-only advanced path, #169)', () => {
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
    fireEvent.click(screen.getByTestId('trade-give-nft-select'));
    fireEvent.click(await screen.findByTestId(`nft-tile-${nftFixture().launcherId}`));
    fireEvent.click(screen.getByTestId('nft-picker-confirm'));
    expect(await screen.findByTestId('trade-give-nft-chosen')).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('trade-get-amount'), { target: { value: '250' } });
    fireEvent.click(screen.getByTestId('trade-make-continue'));
    await screen.findByTestId('trade-make-review');
    fireEvent.click(screen.getByTestId('trade-make-review-confirm'));

    expect(await screen.findByTestId('trade-deal-card')).toBeInTheDocument();
    // #100 — offered/requested are ARRAYS on the wire now (a single-asset offer is a 1-element array).
    expect(capturedOffered).toEqual([{ asset: { kind: 'nft', launcherId: nftFixture().launcherId }, amount: '1' }]);
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

  describe('NFT-trade picker — XL modal (#170)', () => {
    const NFT_A = nftFixture();
    const NFT_B = { ...nftFixture(), launcherId: 'cd'.repeat(32) };

    it('opens the XL modal picker, and picking a tile shows it as the chosen NFT', async () => {
      mockSw((m) => (m.action === 'listNfts' ? { nfts: [NFT_A, NFT_B] } : { success: true }));
      renderWithProviders(<TradePanel assets={twoAssets()} full />);
      fireEvent.click(screen.getByTestId('trade-give-kind-nft'));
      fireEvent.click(await screen.findByTestId('trade-give-nft-select'));

      expect(screen.getByTestId('nft-picker-modal')).toBeInTheDocument();
      fireEvent.click(screen.getByTestId(`nft-tile-${NFT_A.launcherId}`));
      fireEvent.click(screen.getByTestId('nft-picker-confirm'));

      expect(screen.queryByTestId('nft-picker-modal')).not.toBeInTheDocument();
      expect(screen.getByTestId('trade-give-nft-chosen')).toBeInTheDocument();
      expect(screen.queryByTestId('trade-give-nft-select')).not.toBeInTheDocument();
    });

    it('opens in single-select mode — the offer engine supports at most one offered NFT', async () => {
      mockSw((m) => (m.action === 'listNfts' ? { nfts: [NFT_A, NFT_B] } : { success: true }));
      renderWithProviders(<TradePanel assets={twoAssets()} full />);
      fireEvent.click(screen.getByTestId('trade-give-kind-nft'));
      fireEvent.click(await screen.findByTestId('trade-give-nft-select'));
      // single-select mode never shows select-all/clear (they have no meaning for one pick)
      expect(screen.queryByTestId('nft-picker-select-all')).not.toBeInTheDocument();
    });

    it('"Change" reopens the picker pre-selecting the current pick, and picking another replaces it', async () => {
      mockSw((m) => (m.action === 'listNfts' ? { nfts: [NFT_A, NFT_B] } : { success: true }));
      renderWithProviders(<TradePanel assets={twoAssets()} full />);
      fireEvent.click(screen.getByTestId('trade-give-kind-nft'));
      fireEvent.click(await screen.findByTestId('trade-give-nft-select'));
      fireEvent.click(screen.getByTestId(`nft-tile-${NFT_A.launcherId}`));
      fireEvent.click(screen.getByTestId('nft-picker-confirm'));
      await screen.findByTestId('trade-give-nft-chosen');

      fireEvent.click(screen.getByTestId('trade-give-nft-change'));
      expect(screen.getByTestId('nft-picker-count')).toHaveTextContent('1 selected'); // pre-selected
      fireEvent.click(screen.getByTestId(`nft-tile-${NFT_B.launcherId}`));
      expect(screen.getByTestId('nft-picker-count')).toHaveTextContent('1 selected'); // replaced, not added
      fireEvent.click(screen.getByTestId('nft-picker-confirm'));
      expect(screen.getByTestId('trade-give-nft-chosen')).toHaveTextContent(nftDisplayName(NFT_B));
    });

    it('Cancel closes the picker without changing the current pick', async () => {
      mockSw((m) => (m.action === 'listNfts' ? { nfts: [NFT_A, NFT_B] } : { success: true }));
      renderWithProviders(<TradePanel assets={twoAssets()} full />);
      fireEvent.click(screen.getByTestId('trade-give-kind-nft'));
      fireEvent.click(await screen.findByTestId('trade-give-nft-select'));
      fireEvent.click(screen.getByTestId('nft-picker-cancel'));
      expect(screen.queryByTestId('nft-picker-modal')).not.toBeInTheDocument();
      expect(screen.getByTestId('trade-give-nft-select')).toBeInTheDocument(); // still nothing chosen
    });
  });

  it('#166: Close lives in the sticky ViewHeader on both the compact and full surfaces', () => {
    const { unmount } = renderWithProviders(<TradePanel assets={twoAssets()} full={false} onClose={() => {}} />);
    expect(screen.getByTestId('view-header')).toContainElement(screen.getByTestId('trade-close'));
    unmount();

    renderWithProviders(<TradePanel assets={twoAssets()} full onClose={() => {}} />);
    expect(screen.getByTestId('view-header')).toContainElement(screen.getByTestId('trade-close'));
  });
});

describe('TradePanel — multi-asset offers (#100: >1 offered and/or >1 requested asset, fullscreen-only advanced path)', () => {
  it('the popup Make form has no "add asset" controls — basic single-asset only', async () => {
    mockSw(() => ({ success: true }));
    renderWithProviders(<TradePanel assets={twoAssets()} full={false} />);
    await screen.findByTestId('trade-make-form');
    expect(screen.queryByTestId('trade-give-add-asset')).not.toBeInTheDocument();
    expect(screen.queryByTestId('trade-get-add-asset')).not.toBeInTheDocument();
  });

  it('the fullscreen Make form offers "add another asset" on both give and get', async () => {
    mockSw(() => ({ success: true }));
    renderWithProviders(<TradePanel assets={twoAssets()} full />);
    expect(await screen.findByTestId('trade-give-add-asset')).toBeInTheDocument();
    expect(screen.getByTestId('trade-get-add-asset')).toBeInTheDocument();
  });

  it('adding a second GIVE asset sends a 2-element offered array', async () => {
    let capturedOffered: unknown;
    let capturedRequested: unknown;
    mockSw((m) => {
      if (m.action === 'makeOffer') {
        capturedOffered = m.offered;
        capturedRequested = m.requested;
        return { offer: OFFER, offerSummary: SUMMARY };
      }
      return { success: true };
    });
    renderWithProviders(<TradePanel assets={threeAssets()} full />);

    fireEvent.change(screen.getByTestId('trade-give-amount'), { target: { value: '0.1' } }); // give row 0: XCH (idx 0)
    fireEvent.click(screen.getByTestId('trade-give-add-asset'));
    fireEvent.change(screen.getByTestId('trade-give-asset-1'), { target: { value: '2' } }); // give row 1: the 3rd asset — distinct from get's default ($DIG, idx 1)
    fireEvent.change(screen.getByTestId('trade-give-amount-1'), { target: { value: '0.1' } }); // well within the 900-base-unit balance
    fireEvent.change(screen.getByTestId('trade-get-amount'), { target: { value: '250' } }); // get: $DIG (idx 1)
    fireEvent.click(screen.getByTestId('trade-make-continue'));
    await screen.findByTestId('trade-make-review');
    fireEvent.click(screen.getByTestId('trade-make-review-confirm'));

    expect(await screen.findByTestId('trade-deal-card')).toBeInTheDocument();
    expect(capturedOffered).toHaveLength(2);
    expect(capturedRequested).toHaveLength(1);
  });

  it('adding a second GET asset sends a 2-element requested array', async () => {
    let capturedRequested: unknown;
    mockSw((m) => {
      if (m.action === 'makeOffer') {
        capturedRequested = m.requested;
        return { offer: OFFER, offerSummary: SUMMARY };
      }
      return { success: true };
    });
    renderWithProviders(<TradePanel assets={threeAssets()} full />);

    fireEvent.change(screen.getByTestId('trade-give-amount'), { target: { value: '0.1' } }); // give: XCH (idx 0)
    fireEvent.change(screen.getByTestId('trade-get-amount'), { target: { value: '250' } }); // get row 0: $DIG (idx 1)
    fireEvent.click(screen.getByTestId('trade-get-add-asset'));
    fireEvent.change(screen.getByTestId('trade-get-asset-1'), { target: { value: '2' } }); // get row 1: the 3rd asset — distinct from both the give leg AND get row 0
    fireEvent.change(screen.getByTestId('trade-get-amount-1'), { target: { value: '5' } });
    fireEvent.click(screen.getByTestId('trade-make-continue'));
    await screen.findByTestId('trade-make-review');
    fireEvent.click(screen.getByTestId('trade-make-review-confirm'));

    expect(await screen.findByTestId('trade-deal-card')).toBeInTheDocument();
    expect(capturedRequested).toHaveLength(2);
  });

  it('removing an added asset row drops it back to a single leg', async () => {
    mockSw(() => ({ success: true }));
    renderWithProviders(<TradePanel assets={twoAssets()} full />);
    fireEvent.click(screen.getByTestId('trade-give-add-asset'));
    expect(screen.getByTestId('trade-give-asset-1')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('trade-give-remove-asset-1'));
    expect(screen.queryByTestId('trade-give-asset-1')).not.toBeInTheDocument();
  });

  it('rejects picking the SAME asset twice on the give side before reaching review', async () => {
    mockSw(() => ({ success: true }));
    renderWithProviders(<TradePanel assets={twoAssets()} full />);
    fireEvent.change(screen.getByTestId('trade-give-amount'), { target: { value: '0.1' } });
    fireEvent.click(screen.getByTestId('trade-give-add-asset'));
    fireEvent.change(screen.getByTestId('trade-give-asset-1'), { target: { value: '0' } }); // same as row 0 (XCH)
    fireEvent.change(screen.getByTestId('trade-give-amount-1'), { target: { value: '0.2' } });
    fireEvent.change(screen.getByTestId('trade-get-amount'), { target: { value: '250' } });
    fireEvent.click(screen.getByTestId('trade-make-continue'));
    expect(await screen.findByTestId('trade-make-error')).toBeInTheDocument();
    expect(screen.queryByTestId('trade-make-review')).not.toBeInTheDocument();
  });
});
