import { useEffect, useMemo, useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import qrcode from 'qrcode-generator';
import { toBaseUnits, formatBaseUnits } from '@/lib/wallet-view';
import type { AssetBalance } from '@/features/wallet/walletApi';
import type { WireOfferAsset, WireOfferLeg, WireOfferSummary } from '@/offscreen/vault';
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
type MakePhase = 'form' | 'made';
type TakePhase = 'paste' | 'review' | 'confirm' | 'sending' | 'confirmed' | 'failed';

/**
 * Self-custody Trade (§18.10): MAKE a shareable offer (you give / you get → an `offer1…` deal card
 * with copy + QR + cancel) and TAKE one (paste → inspect two-sided summary → prepare → confirm →
 * broadcast → poll). Every money step is build-then-approve; `confirmTrade` is the only broadcast.
 * Amounts use each asset's decimals; the network fee is XCH. `pollMs` is injectable for tests.
 */
export function TradePanel({ assets, onClose, pollMs = 8000 }: { assets: AssetBalance[]; onClose?: () => void; pollMs?: number }) {
  const intl = useIntl();
  const [mode, setMode] = useState<Mode>('make');

  return (
    <section className="dig-card" data-testid="custody-trade" aria-labelledby="trade-title">
      <h2 className="dig-heading" id="trade-title">
        <FormattedMessage id="trade.title" />
      </h2>
      <div className="dig-toggle-row" role="tablist" aria-label={intl.formatMessage({ id: 'trade.title' })} style={{ display: 'flex', gap: 8, margin: '4px 0 12px' }}>
        <button type="button" role="tab" aria-selected={mode === 'make'} className={`dig-btn ${mode === 'make' ? 'dig-btn--primary' : ''}`} data-testid="trade-mode-make" onClick={() => setMode('make')}>
          <FormattedMessage id="trade.mode.make" />
        </button>
        <button type="button" role="tab" aria-selected={mode === 'take'} className={`dig-btn ${mode === 'take' ? 'dig-btn--primary' : ''}`} data-testid="trade-mode-take" onClick={() => setMode('take')}>
          <FormattedMessage id="trade.mode.take" />
        </button>
      </div>

      {mode === 'make' ? <MakeTrade assets={assets} /> : <TakeTrade pollMs={pollMs} />}

      {onClose && (
        <button type="button" className="dig-link" data-testid="trade-close" onClick={onClose}>
          <FormattedMessage id="send.cancel" />
        </button>
      )}
    </section>
  );
}

/** MAKE: pick give/get assets + amounts → build the offer → show the shareable deal card. */
function MakeTrade({ assets }: { assets: AssetBalance[] }) {
  const intl = useIntl();
  const [phase, setPhase] = useState<MakePhase>('form');
  const [giveIdx, setGiveIdx] = useState(0);
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

  const give = assets[giveIdx];
  const get = assets[getIdx];
  const qr = useMemo(() => (offer ? offerQrDataUrl(offer) : null), [offer]);

  async function doMake() {
    if (!give || !get) return;
    if (giveIdx === getIdx) {
      setError(intl.formatMessage({ id: 'trade.error.sameAsset' }));
      return;
    }
    const giveBase = safeBase(giveAmount, decimalsOf(give));
    const getBase = safeBase(getAmount, decimalsOf(get));
    if (giveBase <= 0 || getBase <= 0) {
      setError(intl.formatMessage({ id: 'send.error.amount' }));
      return;
    }
    if ((give.balance ?? 0) < giveBase) {
      setError(intl.formatMessage({ id: 'send.error.insufficient' }));
      return;
    }
    setError(null);
    const offered: WireOfferLeg = { asset: toWireAsset(give), amount: String(giveBase) };
    const requested: WireOfferLeg = { asset: toWireAsset(get), amount: String(getBase) };
    const res = await makeOffer({ offered, requested });
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

  return (
    <form
      data-testid="trade-make-form"
      onSubmit={(e) => {
        e.preventDefault();
        void doMake();
      }}
    >
      <label className="dig-field">
        <span><FormattedMessage id="trade.give" /></span>
        <div style={{ display: 'flex', gap: 8 }}>
          <select className="dig-input" data-testid="trade-give-asset" value={giveIdx} onChange={(e) => setGiveIdx(Number(e.target.value))}>
            {assets.map((a, i) => (
              <option key={`give-${a.descriptor.key}${a.descriptor.assetId ?? ''}`} value={i}>{a.descriptor.ticker}</option>
            ))}
          </select>
          <input className="dig-input" data-testid="trade-give-amount" inputMode="decimal" value={giveAmount} onChange={(e) => setGiveAmount(e.target.value)} aria-label={intl.formatMessage({ id: 'trade.give' })} />
        </div>
      </label>
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
      <button type="submit" className="dig-btn dig-btn--primary dig-btn--block" data-testid="trade-make-submit" disabled={mk.isLoading}>
        <FormattedMessage id={mk.isLoading ? 'custody.working' : 'trade.make.submit'} />
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

  async function doInspect() {
    const trimmed = offerStr.trim();
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

/** Format one leg as "<amount> <ticker>" (XCH decimals for XCH, else a 3-dp CAT default). */
function legLabel(leg: { asset: WireOfferAsset; amount: string }, _intl: ReturnType<typeof useIntl>): string {
  if (leg.asset.kind === 'xch') return `${formatBaseUnits(Number(leg.amount), XCH_DECIMALS)} XCH`;
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
