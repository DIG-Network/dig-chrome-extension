import { useEffect, useMemo, useState, type DragEvent } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import qrcode from 'qrcode-generator';
import { toBaseUnits, formatBaseUnits } from '@/lib/wallet-view';
import { popOutToFullpage } from '@/lib/popout';
import { isFullpageSurface } from '@/features/collectibles/surface';
import { ViewHeader } from '@/components/ViewHeader';
import type { AssetBalance } from '@/features/wallet/assetTypes';
import type { WireOfferAsset, WireOfferLeg, WireOfferSummary } from '@/offscreen/vault';
import { useListCollectiblesQuery } from '@/features/collectibles/collectiblesApi';
import {
  useMakeCustodyOfferMutation,
  useInspectCustodyOfferMutation,
  usePrepareTradeMutation,
  useConfirmTradeMutation,
  useLazySendStatusQuery,
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

type Mode = 'make' | 'take';
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

        {mode === 'make' ? <MakeTrade assets={assets} full={isFull} /> : <TakeTrade pollMs={pollMs} />}
      </section>
    </div>
  );
}

/**
 * MAKE: pick give/get assets + amounts → a "You give / You get" review → build the offer → show
 * the shareable deal card. Guided steps (#169): form → review → made, so nothing is built until
 * the maker has confirmed the exact terms. `full` gates the ADVANCED give-kind toggle (offering an
 * NFT, §94) — the compact popup only offers currency-for-currency (basic maker).
 */
function MakeTrade({ assets, full }: { assets: AssetBalance[]; full: boolean }) {
  const intl = useIntl();
  const [phase, setPhase] = useState<MakePhase>('form');
  const [giveKind, setGiveKind] = useState<GiveKind>('currency');
  const [giveIdx, setGiveIdx] = useState(0);
  const [giveNftIdx, setGiveNftIdx] = useState(0);
  const [getIdx, setGetIdx] = useState(assets.length > 1 ? 1 : 0);
  const [giveAmount, setGiveAmount] = useState('');
  const [getAmount, setGetAmount] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [offer, setOffer] = useState('');
  const [copied, setCopied] = useState(false);

  const [makeOffer, mk] = useMakeCustodyOfferMutation();
  const [prepareTrade, pt] = usePrepareTradeMutation();
  const [confirmTrade, ct] = useConfirmTradeMutation();
  const [cancelState, setCancelState] = useState<'idle' | 'cancelled' | 'failed'>('idle');
  const nfts = useListCollectiblesQuery(undefined, { skip: giveKind !== 'nft' });

  const give = assets[giveIdx];
  const get = assets[getIdx];
  const giveNft = nfts.data?.nfts?.[giveNftIdx];
  const qr = useMemo(() => (offer ? offerQrDataUrl(offer) : null), [offer]);

  /** Validate the current picks and build the two offer legs — the ONE validation path shared by
   * "Continue" (validate only) and the review step's "Create offer" (validate + build). Sets
   * `error` and returns null on any invalid pick; never throws. */
  function computeLegs(): { offered: WireOfferLeg; requested: WireOfferLeg } | null {
    const getBase = safeBase(getAmount, decimalsOf(get));
    if (!get || getBase <= 0) {
      setError(intl.formatMessage({ id: 'send.error.amount' }));
      return null;
    }

    let offered: WireOfferLeg;
    if (giveKind === 'nft') {
      if (!giveNft) return null;
      offered = { asset: { kind: 'nft', launcherId: giveNft.launcherId }, amount: '1' };
    } else {
      if (!give) return null;
      if (giveIdx === getIdx) {
        setError(intl.formatMessage({ id: 'trade.error.sameAsset' }));
        return null;
      }
      const giveBase = safeBase(giveAmount, decimalsOf(give));
      if (giveBase <= 0) {
        setError(intl.formatMessage({ id: 'send.error.amount' }));
        return null;
      }
      if ((give.balance ?? 0) < giveBase) {
        setError(intl.formatMessage({ id: 'send.error.insufficient' }));
        return null;
      }
      offered = { asset: toWireAsset(give), amount: String(giveBase) };
    }

    setError(null);
    return { offered, requested: { asset: toWireAsset(get), amount: String(getBase) } };
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
          <button type="button" className="dig-btn" data-testid="trade-new" onClick={() => { setPhase('form'); setOffer(''); setCancelState('idle'); }}>
            <FormattedMessage id="trade.deal.new" />
          </button>
        </div>
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
  if (phase === 'review') {
    const giveLabel = giveKind === 'nft'
      ? (giveNft ? `NFT ${giveNft.launcherId.slice(0, 6)}…` : '')
      : `${giveAmount || '0'} ${give?.descriptor.ticker ?? ''}`;
    const getLabel = `${getAmount || '0'} ${get?.descriptor.ticker ?? ''}`;
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
          <label className="dig-field">
            <div style={{ display: 'flex', gap: 8 }}>
              <select className="dig-input" data-testid="trade-give-asset" value={giveIdx} onChange={(e) => setGiveIdx(Number(e.target.value))}>
                {assets.map((a, i) => (
                  <option key={`give-${a.descriptor.key}${a.descriptor.assetId ?? ''}`} value={i}>{a.descriptor.ticker}</option>
                ))}
              </select>
              <input className="dig-input" data-testid="trade-give-amount" inputMode="decimal" value={giveAmount} onChange={(e) => setGiveAmount(e.target.value)} aria-label={intl.formatMessage({ id: 'trade.give' })} />
            </div>
          </label>
        ) : nfts.data?.nfts?.length ? (
          <select className="dig-input" data-testid="trade-give-nft" value={giveNftIdx} onChange={(e) => setGiveNftIdx(Number(e.target.value))} aria-label={intl.formatMessage({ id: 'trade.give.kind.nft' })}>
            {nfts.data.nfts.map((n, i) => (
              <option key={n.launcherId} value={i}>{n.launcherId.slice(0, 10)}…</option>
            ))}
          </select>
        ) : (
          <p className="dig-muted" data-testid="trade-give-nft-empty" style={{ margin: 0 }}>
            <FormattedMessage id="trade.give.nft.empty" />
          </p>
        )}
      </div>
      <label className="dig-field">
        <span><FormattedMessage id="trade.get" /></span>
        <div style={{ display: 'flex', gap: 8 }}>
          <select className="dig-input" data-testid="trade-get-asset" value={getIdx} onChange={(e) => setGetIdx(Number(e.target.value))}>
            {assets.map((a, i) => (
              <option key={`get-${a.descriptor.key}${a.descriptor.assetId ?? ''}`} value={i}>{a.descriptor.ticker}</option>
            ))}
          </select>
          <input className="dig-input" data-testid="trade-get-amount" inputMode="decimal" value={getAmount} onChange={(e) => setGetAmount(e.target.value)} aria-label={intl.formatMessage({ id: 'trade.get' })} />
        </div>
      </label>
      {error && <p className="dig-error-text" role="alert" data-testid="trade-make-error">{error}</p>}
      <button type="submit" className="dig-btn dig-btn--primary dig-btn--block" data-testid="trade-make-continue">
        <FormattedMessage id="trade.make.continue" />
      </button>
    </form>
  );
}

/** TAKE: paste an offer → inspect the two-sided summary → prepare → confirm → broadcast → poll. */
function TakeTrade({ pollMs }: { pollMs: number }) {
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

  async function doInspect(text?: string) {
    const trimmed = (text ?? offerStr).trim();
    if (!trimmed.startsWith('offer1')) {
      setError(intl.formatMessage({ id: 'trade.error.invalid' }));
      return;
    }
    setError(null);
    const res = await inspect({ offerStr: trimmed });
    if ('data' in res && res.data?.offerSummary) {
      setSummary(res.data.offerSummary);
      setPhase('review');
    } else {
      setError(intl.formatMessage({ id: 'trade.error.invalid' }));
    }
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
        <TwoSided summary={summary} intl={intl} />
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
    </form>
  );
}

/** The two-sided offer summary (you get = the offered legs; you pay = the requested legs). */
function TwoSided({ summary, intl }: { summary: WireOfferSummary | null; intl: ReturnType<typeof useIntl> }) {
  if (!summary) return null;
  return (
    <dl className="dig-summary" data-testid="trade-summary">
      <dt><FormattedMessage id="trade.summary.youGet" /></dt>
      <dd data-testid="trade-summary-get">{summary.offered.map((l) => legLabel(l, intl)).join(', ') || '—'}</dd>
      <dt><FormattedMessage id="trade.summary.youPay" /></dt>
      <dd data-testid="trade-summary-pay">{summary.requested.map((l) => legLabel(l, intl)).join(', ') || '—'}</dd>
    </dl>
  );
}

/** Format one leg as "<amount> <ticker>" (XCH decimals for XCH; a 3-dp CAT default; NFT by launcher id). */
function legLabel(leg: { asset: WireOfferAsset; amount: string }, _intl: ReturnType<typeof useIntl>): string {
  if (leg.asset.kind === 'xch') return `${formatBaseUnits(Number(leg.amount), XCH_DECIMALS)} XCH`;
  if (leg.asset.kind === 'nft') return `NFT ${leg.asset.launcherId.slice(0, 6)}…`;
  return `${formatBaseUnits(Number(leg.amount), 3)} ${leg.asset.assetId.slice(0, 6)}…`;
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
