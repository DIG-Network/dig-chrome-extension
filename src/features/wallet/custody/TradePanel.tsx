import { useEffect, useMemo, useState, type DragEvent } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import qrcode from 'qrcode-generator';
import { toBaseUnits } from '@/lib/wallet-view';
import { popOutToFullpage } from '@/lib/popout';
import { isFullpageSurface } from '@/features/collectibles/surface';
import { ViewHeader } from '@/components/ViewHeader';
import { FourState } from '@/components/FourState';
import type { AssetBalance } from '@/features/wallet/assetTypes';
import type { WireOfferAsset, WireOfferLeg, WireOfferSummary } from '@/offscreen/vault';
import { useListCollectiblesQuery } from '@/features/collectibles/collectiblesApi';
import { NftPickerModal } from '@/features/collectibles/NftPickerModal';
import { NftMedia } from '@/features/collectibles/NftDetail';
import { nftDisplayName, nftImageSrc } from '@/features/collectibles/nftDisplay';
import { legLabel } from '@/features/wallet/custody/offerLegFormat';
import { OffersPanel } from '@/features/wallet/custody/OffersPanel';
import {
  useMakeCustodyOfferMutation,
  useInspectCustodyOfferMutation,
  usePrepareTradeMutation,
  useConfirmTradeMutation,
  useLazySendStatusQuery,
  usePostOfferToDexieMutation,
  useBrowseDexieOffersQuery,
  useResolveDexieOfferMutation,
} from '@/features/wallet/custodyApi';

const XCH_DECIMALS = 12;

/** Map a wallet asset row → the wire asset descriptor the offer engine expects. */
function toWireAsset(a: AssetBalance): WireOfferAsset {
  return a.descriptor.key === 'xch' || !a.descriptor.assetId ? { kind: 'xch' } : { kind: 'cat', assetId: a.descriptor.assetId };
}
const decimalsOf = (a: AssetBalance | undefined): number => a?.descriptor.decimals ?? XCH_DECIMALS;

/** Render an offer string as a scannable QR data-URL (CSP-safe GIF); null if it won't fit. */
function offerQrDataUrl(offer: string): string | null {
  try {
    const qr = qrcode(0, 'L');
    qr.addData(offer);
    qr.make();
    return qr.createDataURL(3, 8);
  } catch {
    return null; // too long for a single QR — the copyable string still works
  }
}

type Mode = 'make' | 'take' | 'offers';
type MakePhase = 'form' | 'review' | 'made';
type TakePhase = 'paste' | 'review' | 'confirm' | 'sending' | 'confirmed' | 'failed';
/** What the maker is GIVING: a fungible balance (XCH/CAT) or one of the wallet's own NFTs (§94). */
type GiveKind = 'currency' | 'nft';

/**
 * Self-custody Trade (§18.10): MAKE a shareable offer (you give / you get → review → an `offer1…`
 * deal card with copy + QR + cancel) and TAKE one (paste/drag → inspect two-sided summary →
 * prepare → confirm → broadcast → poll). Every money step is build-then-approve; `confirmTrade`
 * is the only broadcast. Amounts use each asset's decimals; the network fee is XCH. `pollMs` is
 * injectable for tests.
 *
 * **Surface tiering (#169, refining #145): a BASIC maker/taker renders on BOTH surfaces.** Taking
 * an offer has no "advanced" version (you accept what's offered, so it is basic by nature) and
 * always renders in full. Making an offer renders a currency-for-currency basic form on BOTH
 * surfaces too; only the ADVANCED capability — offering one of the wallet's own NFTs (§94's
 * give-kind toggle) — is fullscreen (ExpandedLayout) ONLY, hidden from {@link MakeTrade} via its
 * `full` prop. The compact popup keeps a persistent "open full screen" link for that + any future
 * advanced option (multi-asset, fee tuning). `full` is auto-detected from the surface (overridable
 * in tests).
 */
export function TradePanel({ assets, onClose, pollMs = 8000, full }: { assets: AssetBalance[]; onClose?: () => void; pollMs?: number; full?: boolean }) {
  const intl = useIntl();
  const [mode, setMode] = useState<Mode>('make');
  const isFull = full ?? isFullpageSurface();

  return (
    <div data-testid="custody-trade">
      <ViewHeader
        onBack={onClose}
        backLabel={<FormattedMessage id="send.cancel" />}
        backTestId="trade-close"
        title={<FormattedMessage id="trade.title" />}
        titleId="trade-title"
      />
      <section className="dig-card" aria-labelledby="trade-title">
        <p className="dig-muted" style={{ marginTop: 0 }}>
          <FormattedMessage id="trade.intro" />
        </p>
        <div
          className="dig-toggle-row"
          role="tablist"
          aria-label={intl.formatMessage({ id: 'trade.title' })}
          style={{ display: 'flex', gap: 8, margin: '4px 0 12px', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' }}
        >
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" role="tab" aria-selected={mode === 'make'} className={`dig-btn ${mode === 'make' ? 'dig-btn--primary' : ''}`} data-testid="trade-mode-make" onClick={() => setMode('make')}>
              <FormattedMessage id="trade.mode.make" />
            </button>
            <button type="button" role="tab" aria-selected={mode === 'take'} className={`dig-btn ${mode === 'take' ? 'dig-btn--primary' : ''}`} data-testid="trade-mode-take" onClick={() => setMode('take')}>
              <FormattedMessage id="trade.mode.take" />
            </button>
            <button type="button" role="tab" aria-selected={mode === 'offers'} className={`dig-btn ${mode === 'offers' ? 'dig-btn--primary' : ''}`} data-testid="trade-mode-offers" onClick={() => setMode('offers')}>
              <FormattedMessage id="trade.mode.offers" />
            </button>
          </div>
          {!isFull && (
            <button
              type="button"
              className="dig-link"
              data-testid="trade-open-fullscreen"
              onClick={() => void popOutToFullpage('#wallet/trade', true)}
            >
              <FormattedMessage id="trade.openFullscreen" />
            </button>
          )}
        </div>

        {mode === 'make' && <MakeTrade assets={assets} full={isFull} />}
        {mode === 'take' && <TakeTrade pollMs={pollMs} full={isFull} />}
        {mode === 'offers' && <OffersPanel full={isFull} />}
      </section>
    </div>
  );
}

/** One currency (XCH/CAT) leg being edited in the multi-asset give/get builder (#100): which asset
 * row it points at (an index into `assets`) + its decimal-string amount. */
interface CurrencyLegDraft {
  assetIdx: number;
  amount: string;
}

/** A stable overlap/dedupe key for one wire offer leg — same asset identity ⇒ same key (#100,
 * mirrors the offer engine's own `assetKey`, kept client-side for an immediate inline error rather
 * than a round trip to discover a DUPLICATE_ASSET/SAME_ASSET failure). */
function wireLegKey(l: WireOfferLeg): string {
  return l.asset.kind === 'xch' ? 'xch' : l.asset.kind === 'cat' ? `cat:${l.asset.assetId}` : `nft:${l.asset.launcherId}`;
}

/** The first asset index NOT already used by `legs` (falls back to 0 when every asset is used —
 * the user can still change it; validation catches a resulting duplicate). */
function nextUnusedAssetIdx(assets: AssetBalance[], legs: CurrencyLegDraft[]): number {
  const used = new Set(legs.map((l) => l.assetIdx));
  for (let i = 0; i < assets.length; i++) if (!used.has(i)) return i;
  return 0;
}

/**
 * MAKE: pick give/get assets + amounts → a "You give / You get" review → build the offer → show
 * the shareable deal card. Guided steps (#169): form → review → made, so nothing is built until
 * the maker has confirmed the exact terms. `full` gates TWO advanced capabilities — offering an NFT
 * (§94) and composing MULTIPLE assets per side (#100, "+ Add another asset"); the compact popup
 * stays a single currency-for-currency leg on each side (basic maker).
 *
 * **Multi-asset (#100).** `giveLegs`/`getLegs` are arrays of {@link CurrencyLegDraft} — 1 element in
 * the popup (no add/remove controls rendered), 1-or-more in fullscreen. Every leg on a side must
 * name a DIFFERENT asset (checked client-side before ever building anything, mirroring the engine's
 * own `DUPLICATE_ASSET`/`SAME_ASSET` checks), and no asset may appear on BOTH sides. Offering an NFT
 * (`giveKind === 'nft'`) stays a single exclusive leg — the v1 offer engine supports at most one
 * offered NFT — so the "+ Add another asset" control only applies to the currency give path.
 *
 * **NFT picker (#170).** Choosing the offered NFT opens the {@link NftPickerModal} XL modal (the
 * wallet's NFTs in a searchable grid) instead of a plain dropdown, giving real thumbnails + search
 * for wallets with many NFTs. The modal is opened `multiple={false}`: the offer engine's v1 model
 * supports at most ONE offered NFT per trade (§18.10), so picking a new tile REPLACES the prior
 * pick rather than adding to it — the modal's own multi-select capability is generic (reused as-is
 * for any future context that needs more than one), only this call site caps it to one.
 */
function MakeTrade({ assets, full }: { assets: AssetBalance[]; full: boolean }) {
  const intl = useIntl();
  const [phase, setPhase] = useState<MakePhase>('form');
  const [giveKind, setGiveKind] = useState<GiveKind>('currency');
  const [giveLegs, setGiveLegs] = useState<CurrencyLegDraft[]>([{ assetIdx: 0, amount: '' }]);
  const [giveNftLauncherId, setGiveNftLauncherId] = useState<string | null>(null);
  const [nftPickerOpen, setNftPickerOpen] = useState(false);
  const [getLegs, setGetLegs] = useState<CurrencyLegDraft[]>([{ assetIdx: assets.length > 1 ? 1 : 0, amount: '' }]);
  const [error, setError] = useState<string | null>(null);
  const [offer, setOffer] = useState('');
  const [copied, setCopied] = useState(false);

  const [makeOffer, mk] = useMakeCustodyOfferMutation();
  const [prepareTrade, pt] = usePrepareTradeMutation();
  const [confirmTrade, ct] = useConfirmTradeMutation();
  const [cancelState, setCancelState] = useState<'idle' | 'cancelled' | 'failed'>('idle');
  const nfts = useListCollectiblesQuery(undefined, { skip: giveKind !== 'nft' });

  // dexie marketplace integration (#102, fullscreen-only advanced action): post the just-made offer
  // so other wallets can discover it via dexie's public listing.
  const [postToDexie, dx] = usePostOfferToDexieMutation();
  const [dexieState, setDexieState] = useState<'idle' | 'posted' | 'failed'>('idle');
  async function doPostToDexie() {
    const res = await postToDexie({ offer });
    setDexieState('data' in res && res.data?.dexieId ? 'posted' : 'failed');
  }

  const giveNft = nfts.data?.nfts?.find((n) => n.launcherId === giveNftLauncherId);
  const qr = useMemo(() => (offer ? offerQrDataUrl(offer) : null), [offer]);

  const updateGiveLeg = (i: number, patch: Partial<CurrencyLegDraft>) =>
    setGiveLegs((legs) => legs.map((l, li) => (li === i ? { ...l, ...patch } : l)));
  const updateGetLeg = (i: number, patch: Partial<CurrencyLegDraft>) =>
    setGetLegs((legs) => legs.map((l, li) => (li === i ? { ...l, ...patch } : l)));
  const addGiveLeg = () => setGiveLegs((legs) => [...legs, { assetIdx: nextUnusedAssetIdx(assets, legs), amount: '' }]);
  const addGetLeg = () => setGetLegs((legs) => [...legs, { assetIdx: nextUnusedAssetIdx(assets, legs), amount: '' }]);
  const removeGiveLeg = (i: number) => setGiveLegs((legs) => (legs.length > 1 ? legs.filter((_, li) => li !== i) : legs));
  const removeGetLeg = (i: number) => setGetLegs((legs) => (legs.length > 1 ? legs.filter((_, li) => li !== i) : legs));

  /** Build + validate one side's currency legs into wire legs, or return null (setting `error`) on
   * the first invalid amount / insufficient balance / duplicate asset within the side. */
  function buildCurrencyLegs(legs: CurrencyLegDraft[], checkBalance: boolean): WireOfferLeg[] | null {
    const seen = new Set<string>();
    const out: WireOfferLeg[] = [];
    for (const leg of legs) {
      const asset = assets[leg.assetIdx];
      if (!asset) return null;
      const base = safeBase(leg.amount, decimalsOf(asset));
      if (base <= 0) {
        setError(intl.formatMessage({ id: 'send.error.amount' }));
        return null;
      }
      if (checkBalance && (asset.balance ?? 0) < base) {
        setError(intl.formatMessage({ id: 'send.error.insufficient' }));
        return null;
      }
      const wireLeg = { asset: toWireAsset(asset), amount: String(base) };
      const key = wireLegKey(wireLeg);
      if (seen.has(key)) {
        setError(intl.formatMessage({ id: 'trade.error.sameAsset' }));
        return null;
      }
      seen.add(key);
      out.push(wireLeg);
    }
    return out;
  }

  /** Validate the current picks and build the two offer leg arrays — the ONE validation path shared
   * by "Continue" (validate only) and the review step's "Create offer" (validate + build). Sets
   * `error` and returns null on any invalid pick; never throws. */
  function computeLegs(): { offered: WireOfferLeg[]; requested: WireOfferLeg[] } | null {
    const requested = buildCurrencyLegs(getLegs, false);
    if (!requested) return null;

    let offered: WireOfferLeg[];
    if (giveKind === 'nft') {
      if (!giveNft) return null;
      offered = [{ asset: { kind: 'nft', launcherId: giveNft.launcherId }, amount: '1' }];
    } else {
      const built = buildCurrencyLegs(giveLegs, true);
      if (!built) return null;
      offered = built;
    }

    // Generalized SAME_ASSET (#100): no asset may appear on BOTH sides.
    const offeredKeys = new Set(offered.map(wireLegKey));
    if (requested.some((r) => offeredKeys.has(wireLegKey(r)))) {
      setError(intl.formatMessage({ id: 'trade.error.sameAsset' }));
      return null;
    }

    setError(null);
    return { offered, requested };
  }

  /** Step 1 → 2: validate the picks and move to the "You give / You get" review (no network call). */
  function doContinue() {
    if (computeLegs()) setPhase('review');
  }

  /** Step 2's Confirm: the ONLY network call — builds the offer via the engine. */
  async function doMake() {
    const legs = computeLegs();
    if (!legs) {
      setPhase('form'); // a pick changed underneath the review (e.g. balance dropped) — re-validate on the form
      return;
    }
    const res = await makeOffer(legs);
    if ('data' in res && res.data?.offer) {
      setOffer(res.data.offer);
      setPhase('made');
    } else {
      setError(intl.formatMessage({ id: 'trade.error.build' }));
    }
  }

  async function doCancel() {
    const prep = await prepareTrade({ offerStr: offer, tradeKind: 'cancel' });
    if (!('data' in prep) || !prep.data?.pendingId) {
      setCancelState('failed');
      return;
    }
    const done = await confirmTrade({ pendingId: prep.data.pendingId });
    setCancelState('data' in done && done.data?.spentCoinId ? 'cancelled' : 'failed');
  }

  function copyOffer() {
    void navigator.clipboard?.writeText(offer).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => setCopied(false),
    );
  }

  if (phase === 'made') {
    return (
      <div data-testid="trade-deal-card">
        <p className="dig-muted" style={{ marginTop: 0 }}>
          <FormattedMessage id="trade.deal.intro" />
        </p>
        {qr && <img className="dig-qr" data-testid="trade-qr" src={qr} alt={intl.formatMessage({ id: 'trade.deal.qrAlt' })} style={{ display: 'block', margin: '0 auto 10px', imageRendering: 'pixelated', maxWidth: '100%' }} />}
        <textarea className="dig-input dig-mono" data-testid="trade-offer-string" readOnly rows={4} value={offer} style={{ width: '100%', resize: 'vertical' }} />
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button type="button" className="dig-btn dig-btn--primary" data-testid="trade-copy" onClick={copyOffer}>
            <FormattedMessage id={copied ? 'trade.deal.copied' : 'trade.deal.copy'} />
          </button>
          <button type="button" className="dig-btn" data-testid="trade-new" onClick={() => { setPhase('form'); setOffer(''); setCancelState('idle'); setDexieState('idle'); }}>
            <FormattedMessage id="trade.deal.new" />
          </button>
        </div>
        {full && (
          <div style={{ marginTop: 8 }}>
            {dexieState === 'posted' ? (
              <p className="dig-state" data-state="success" role="status" data-testid="trade-deal-dexie-posted">
                <FormattedMessage id="trade.dexie.posted" />
              </p>
            ) : (
              <button type="button" className="dig-btn" data-testid="trade-deal-dexie-post" onClick={() => void doPostToDexie()} disabled={dx.isLoading}>
                <FormattedMessage id={dx.isLoading ? 'custody.working' : 'trade.dexie.post'} />
              </button>
            )}
            {dexieState === 'failed' && (
              <p className="dig-error-text" role="alert" data-testid="trade-deal-dexie-post-failed">
                <FormattedMessage id="trade.dexie.postFailed" />
              </p>
            )}
          </div>
        )}
        {cancelState === 'cancelled' ? (
          <p className="dig-state" data-state="success" role="status" data-testid="trade-cancelled" style={{ marginTop: 10 }}>
            <FormattedMessage id="trade.cancel.done" />
          </p>
        ) : (
          <button type="button" className="dig-link" data-testid="trade-cancel-offer" onClick={() => void doCancel()} disabled={pt.isLoading || ct.isLoading} style={{ marginTop: 6 }}>
            <FormattedMessage id={pt.isLoading || ct.isLoading ? 'custody.working' : 'trade.cancel.action'} />
          </button>
        )}
        {cancelState === 'failed' && (
          <p className="dig-error-text" role="alert" data-testid="trade-cancel-failed"><FormattedMessage id="trade.cancel.failed" /></p>
        )}
      </div>
    );
  }

  // Step 2 (#169): the "You give / You get" review — the terms are fixed at this point; Confirm is
  // the ONLY place `makeOffer` is actually called. Mirrors `TwoSided`'s take-side review framing.
  // Multi-asset (#100): each side's legs join with " + " ("0.1 XCH + 10 $DIG").
  if (phase === 'review') {
    const legLabel = (leg: CurrencyLegDraft) => `${leg.amount || '0'} ${assets[leg.assetIdx]?.descriptor.ticker ?? ''}`;
    const giveLabel = giveKind === 'nft'
      ? (giveNft ? `NFT ${giveNft.launcherId.slice(0, 6)}…` : '')
      : giveLegs.map(legLabel).join(' + ');
    const getLabel = getLegs.map(legLabel).join(' + ');
    return (
      <div data-testid="trade-make-review">
        <p className="dig-muted" style={{ marginTop: 0 }}>
          <FormattedMessage id="trade.make.review.intro" />
        </p>
        <dl className="dig-summary">
          <dt><FormattedMessage id="trade.give" /></dt>
          <dd data-testid="trade-make-review-give">{giveLabel}</dd>
          <dt><FormattedMessage id="trade.get" /></dt>
          <dd data-testid="trade-make-review-get">{getLabel}</dd>
        </dl>
        {error && <p className="dig-error-text" role="alert" data-testid="trade-make-error">{error}</p>}
        <button type="button" className="dig-btn dig-btn--primary dig-btn--block" data-testid="trade-make-review-confirm" onClick={() => void doMake()} disabled={mk.isLoading}>
          <FormattedMessage id={mk.isLoading ? 'custody.working' : 'trade.make.submit'} />
        </button>
        <button type="button" className="dig-link" data-testid="trade-make-review-back" onClick={() => setPhase('form')} style={{ marginTop: 6 }}>
          <FormattedMessage id="send.back" />
        </button>
      </div>
    );
  }

  return (
    <form
      data-testid="trade-make-form"
      onSubmit={(e) => {
        e.preventDefault();
        doContinue();
      }}
    >
      <div className="dig-field">
        <span><FormattedMessage id="trade.give" /></span>
        {full && (
          <div className="dig-toggle-row" role="tablist" aria-label={intl.formatMessage({ id: 'trade.give' })} style={{ display: 'flex', gap: 8, margin: '4px 0 8px' }}>
            <button
              type="button"
              role="tab"
              aria-selected={giveKind === 'currency'}
              className={`dig-btn ${giveKind === 'currency' ? 'dig-btn--primary' : ''}`}
              data-testid="trade-give-kind-currency"
              onClick={() => setGiveKind('currency')}
            >
              <FormattedMessage id="trade.give.kind.currency" />
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={giveKind === 'nft'}
              className={`dig-btn ${giveKind === 'nft' ? 'dig-btn--primary' : ''}`}
              data-testid="trade-give-kind-nft"
              onClick={() => setGiveKind('nft')}
            >
              <FormattedMessage id="trade.give.kind.nft" />
            </button>
          </div>
        )}
        {giveKind === 'currency' ? (
          <>
            {giveLegs.map((leg, i) => (
              <div key={i} className="dig-field" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <select
                  className="dig-input"
                  data-testid={i === 0 ? 'trade-give-asset' : `trade-give-asset-${i}`}
                  value={leg.assetIdx}
                  onChange={(e) => updateGiveLeg(i, { assetIdx: Number(e.target.value) })}
                >
                  {assets.map((a, ai) => (
                    <option key={`give-${i}-${a.descriptor.key}${a.descriptor.assetId ?? ''}`} value={ai}>{a.descriptor.ticker}</option>
                  ))}
                </select>
                <input
                  className="dig-input"
                  data-testid={i === 0 ? 'trade-give-amount' : `trade-give-amount-${i}`}
                  inputMode="decimal"
                  value={leg.amount}
                  onChange={(e) => updateGiveLeg(i, { amount: e.target.value })}
                  aria-label={intl.formatMessage({ id: 'trade.give' })}
                />
                {full && i > 0 && (
                  <button
                    type="button"
                    className="dig-link"
                    data-testid={`trade-give-remove-asset-${i}`}
                    onClick={() => removeGiveLeg(i)}
                    aria-label={intl.formatMessage({ id: 'wallet.switcher.remove' })}
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
            {full && (
              <button type="button" className="dig-link" data-testid="trade-give-add-asset" onClick={addGiveLeg}>
                <FormattedMessage id="trade.addAsset" />
              </button>
            )}
          </>
        ) : nfts.data?.nfts?.length ? (
          <div data-testid="trade-give-nft">
            {giveNft ? (
              <div className="dig-toggle-row" data-testid="trade-give-nft-chosen" style={{ gap: 10 }}>
                <div style={{ width: 40, height: 40, flexShrink: 0 }}>
                  <NftMedia nft={giveNft} imageSrc={nftImageSrc(giveNft)} />
                </div>
                <span className="dig-mono" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {nftDisplayName(giveNft)}
                </span>
                <button type="button" className="dig-link" data-testid="trade-give-nft-change" onClick={() => setNftPickerOpen(true)}>
                  <FormattedMessage id="trade.give.nft.change" />
                </button>
              </div>
            ) : (
              <button type="button" className="dig-btn" data-testid="trade-give-nft-select" onClick={() => setNftPickerOpen(true)}>
                <FormattedMessage id="trade.give.nft.select" />
              </button>
            )}
          </div>
        ) : (
          <p className="dig-muted" data-testid="trade-give-nft-empty" style={{ margin: 0 }}>
            <FormattedMessage id="trade.give.nft.empty" />
          </p>
        )}
      </div>
      {nftPickerOpen && (
        <NftPickerModal
          multiple={false}
          initialSelectedIds={giveNftLauncherId ? [giveNftLauncherId] : []}
          titleId="trade.give.nft.select"
          onClose={() => setNftPickerOpen(false)}
          onConfirm={(chosen) => {
            setGiveNftLauncherId(chosen[0]?.launcherId ?? null);
            setNftPickerOpen(false);
          }}
        />
      )}
      <div className="dig-field">
        <span><FormattedMessage id="trade.get" /></span>
        {getLegs.map((leg, i) => (
          <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
            <select
              className="dig-input"
              data-testid={i === 0 ? 'trade-get-asset' : `trade-get-asset-${i}`}
              value={leg.assetIdx}
              onChange={(e) => updateGetLeg(i, { assetIdx: Number(e.target.value) })}
            >
              {assets.map((a, ai) => (
                <option key={`get-${i}-${a.descriptor.key}${a.descriptor.assetId ?? ''}`} value={ai}>{a.descriptor.ticker}</option>
              ))}
            </select>
            <input
              className="dig-input"
              data-testid={i === 0 ? 'trade-get-amount' : `trade-get-amount-${i}`}
              inputMode="decimal"
              value={leg.amount}
              onChange={(e) => updateGetLeg(i, { amount: e.target.value })}
              aria-label={intl.formatMessage({ id: 'trade.get' })}
            />
            {full && i > 0 && (
              <button
                type="button"
                className="dig-link"
                data-testid={`trade-get-remove-asset-${i}`}
                onClick={() => removeGetLeg(i)}
                aria-label={intl.formatMessage({ id: 'wallet.switcher.remove' })}
              >
                ×
              </button>
            )}
          </div>
        ))}
        {full && (
          <button type="button" className="dig-link" data-testid="trade-get-add-asset" onClick={addGetLeg}>
            <FormattedMessage id="trade.addAsset" />
          </button>
        )}
      </div>
      {error && <p className="dig-error-text" role="alert" data-testid="trade-make-error">{error}</p>}
      <button type="submit" className="dig-btn dig-btn--primary dig-btn--block" data-testid="trade-make-continue">
        <FormattedMessage id="trade.make.continue" />
      </button>
    </form>
  );
}

/** TAKE: paste an offer → inspect the two-sided summary → prepare → confirm → broadcast → poll. */
function TakeTrade({ pollMs, full }: { pollMs: number; full: boolean }) {
  const intl = useIntl();
  const [phase, setPhase] = useState<TakePhase>('paste');
  const [offerStr, setOfferStr] = useState('');
  const [summary, setSummary] = useState<WireOfferSummary | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [spentCoinId, setSpentCoinId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [inspect, ins] = useInspectCustodyOfferMutation();
  const [prepareTrade, pt] = usePrepareTradeMutation();
  const [confirmTrade, ct] = useConfirmTradeMutation();
  const [pollStatus] = useLazySendStatusQuery();

  // dexie marketplace integration (#102, fullscreen-only advanced action): browse open offers +
  // import one, and auto-resolve a pasted dexie link/id before the normal offer1… validation.
  const [resolveDexieOffer] = useResolveDexieOfferMutation();
  const [dexieBrowseOpen, setDexieBrowseOpen] = useState(false);
  const browse = useBrowseDexieOffersQuery(undefined, { skip: !dexieBrowseOpen });

  async function doInspect(text?: string) {
    let trimmed = (text ?? offerStr).trim();
    if (!trimmed.startsWith('offer1')) {
      // Not a raw offer string — try resolving it as a dexie link/id (#102) before rejecting.
      const resolved = await resolveDexieOffer({ idOrUrl: trimmed });
      const resolvedOffer = 'data' in resolved ? resolved.data?.offer : null;
      if (!resolvedOffer?.offerStr) {
        setError(intl.formatMessage({ id: 'trade.error.invalid' }));
        return;
      }
      trimmed = resolvedOffer.offerStr;
    }
    setError(null);
    const res = await inspect({ offerStr: trimmed });
    if ('data' in res && res.data?.offerSummary) {
      setOfferStr(trimmed);
      setSummary(res.data.offerSummary);
      setPhase('review');
    } else {
      setError(intl.formatMessage({ id: 'trade.error.invalid' }));
    }
  }

  /** Import a dexie-browsed offer directly (its bytes are already known — no resolve round trip). */
  function importDexieOffer(offer: string) {
    setOfferStr(offer);
    void doInspect(offer);
  }

  /** Read a dropped `.offer`/text file's contents, populate the field, and inspect it immediately. */
  async function onDropOffer(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    const text = (await readFileText(file)).trim();
    setOfferStr(text);
    void doInspect(text);
  }

  async function doPrepare() {
    const res = await prepareTrade({ offerStr: offerStr.trim(), tradeKind: 'take' });
    if ('data' in res && res.data?.pendingId) {
      setPendingId(res.data.pendingId);
      setSummary(res.data.offerSummary);
      setPhase('confirm');
    } else {
      setError(intl.formatMessage({ id: 'trade.error.build' }));
      setPhase('paste');
    }
  }

  async function doConfirm() {
    if (!pendingId) return;
    setPhase('sending');
    const res = await confirmTrade({ pendingId });
    if ('data' in res && res.data?.spentCoinId) setSpentCoinId(res.data.spentCoinId);
    else setPhase('failed');
  }

  // Poll a broadcast trade to a terminal confirmed state (an input coin recorded spent).
  useEffect(() => {
    if (phase !== 'sending' || !spentCoinId) return;
    let live = true;
    const timer = setInterval(async () => {
      const res = await pollStatus({ coinId: spentCoinId });
      if (live && 'data' in res && res.data?.confirmed) {
        setPhase('confirmed');
        clearInterval(timer);
      }
    }, pollMs);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [phase, spentCoinId, pollMs, pollStatus]);

  const busy = ins.isLoading || pt.isLoading || ct.isLoading;

  if (phase === 'review' || phase === 'confirm') {
    return (
      <div data-testid="trade-take-review">
        <TwoSided summary={summary} />
        {phase === 'review' ? (
          <>
            <button type="button" className="dig-btn dig-btn--primary dig-btn--block" data-testid="trade-take-accept" onClick={() => void doPrepare()} disabled={busy}>
              <FormattedMessage id={busy ? 'custody.working' : 'trade.take.accept'} />
            </button>
            <button type="button" className="dig-link" data-testid="trade-take-back" onClick={() => setPhase('paste')}>
              <FormattedMessage id="send.back" />
            </button>
          </>
        ) : (
          <>
            <p className="dig-muted"><FormattedMessage id="trade.take.confirmIntro" /></p>
            <button type="button" className="dig-btn dig-btn--primary dig-btn--block" data-testid="trade-take-confirm" onClick={() => void doConfirm()} disabled={busy}>
              <FormattedMessage id="trade.take.confirm" />
            </button>
            <button type="button" className="dig-link" data-testid="trade-take-back2" onClick={() => setPhase('review')}>
              <FormattedMessage id="send.back" />
            </button>
          </>
        )}
      </div>
    );
  }

  if (phase === 'sending') {
    return (
      <div className="dig-state" data-state="loading" role="status" data-testid="trade-sending">
        <FormattedMessage id="trade.take.sending" />
      </div>
    );
  }
  if (phase === 'confirmed') {
    return (
      <div className="dig-state" data-state="success" role="status" data-testid="trade-confirmed">
        <FormattedMessage id="trade.take.confirmed" />
      </div>
    );
  }
  if (phase === 'failed') {
    return (
      <div className="dig-state" data-state="error" role="alert" data-testid="trade-failed">
        <p><FormattedMessage id="trade.take.failed" /></p>
        <button type="button" className="dig-btn dig-btn--block" data-testid="trade-take-retry" onClick={() => setPhase('paste')}>
          <FormattedMessage id="state.retry" />
        </button>
      </div>
    );
  }

  return (
    <form
      data-testid="trade-take-form"
      onSubmit={(e) => {
        e.preventDefault();
        void doInspect();
      }}
    >
      <div
        className="dig-dropzone"
        data-testid="trade-take-dropzone"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => void onDropOffer(e)}
        style={{ border: '1px dashed var(--dig-border, #444)', borderRadius: 8, padding: 14, marginBottom: 10, textAlign: 'center' }}
      >
        <p className="dig-muted" style={{ margin: 0 }}>
          <FormattedMessage id="trade.take.drop" />
        </p>
      </div>
      <label className="dig-field">
        <span><FormattedMessage id="trade.take.label" /></span>
        <textarea className="dig-input dig-mono" data-testid="trade-take-input" rows={4} value={offerStr} onChange={(e) => setOfferStr(e.target.value)} placeholder="offer1…" spellCheck={false} style={{ width: '100%', resize: 'vertical' }} />
      </label>
      {error && <p className="dig-error-text" role="alert" data-testid="trade-take-error">{error}</p>}
      <button type="submit" className="dig-btn dig-btn--primary dig-btn--block" data-testid="trade-take-review-btn" disabled={busy}>
        <FormattedMessage id={busy ? 'custody.working' : 'trade.take.review'} />
      </button>
      {full && (
        <div style={{ marginTop: 10 }}>
          <button type="button" className="dig-link" data-testid="trade-take-dexie-browse" onClick={() => setDexieBrowseOpen((v) => !v)}>
            <FormattedMessage id="trade.dexie.browse" />
          </button>
          {dexieBrowseOpen && (
            <FourState
              isLoading={browse.isLoading}
              isError={browse.isError}
              isEmpty={!browse.isLoading && !browse.isError && (browse.data?.offers.length ?? 0) === 0}
              onRetry={() => void browse.refetch()}
              testid="trade-take-dexie-browse"
              emptyId="trade.dexie.browseEmpty"
            >
              <ul className="dig-list" data-testid="trade-take-dexie-browse-list" style={{ listStyle: 'none', padding: 0, margin: '8px 0 0' }}>
                {(browse.data?.offers ?? []).map((o) => (
                  <li key={o.id} className="dig-card" style={{ marginBottom: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                    <span className="dig-mono">
                      {o.offered.map((a) => `${a.amount} ${a.code}`).join(' + ')} → {o.requested.map((a) => `${a.amount} ${a.code}`).join(' + ')}
                    </span>
                    <button type="button" className="dig-btn" data-testid={`trade-take-dexie-import-${o.id}`} onClick={() => importDexieOffer(o.offerStr)}>
                      <FormattedMessage id="trade.dexie.import" />
                    </button>
                  </li>
                ))}
              </ul>
            </FourState>
          )}
        </div>
      )}
    </form>
  );
}

/** The two-sided offer summary (you get = the offered legs; you pay = the requested legs). */
function TwoSided({ summary }: { summary: WireOfferSummary | null }) {
  if (!summary) return null;
  return (
    <dl className="dig-summary" data-testid="trade-summary">
      <dt><FormattedMessage id="trade.summary.youGet" /></dt>
      <dd data-testid="trade-summary-get">{summary.offered.map((l) => legLabel(l)).join(', ') || '—'}</dd>
      <dt><FormattedMessage id="trade.summary.youPay" /></dt>
      <dd data-testid="trade-summary-pay">{summary.requested.map((l) => legLabel(l)).join(', ') || '—'}</dd>
    </dl>
  );
}

/** Parse a decimal amount to base units; 0 on garbage. */
function safeBase(value: string, decimals: number): number {
  try {
    const n = toBaseUnits(value || '0', decimals);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** Read a `File`'s text via `FileReader` (broader support than `File.text()` — e.g. under jsdom). */
function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error ?? new Error('FILE_READ_ERROR'));
    reader.readAsText(file);
  });
}
