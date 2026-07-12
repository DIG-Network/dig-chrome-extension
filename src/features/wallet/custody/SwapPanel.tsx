import { useEffect, useMemo, useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { FourState } from '@/components/FourState';
import type { AssetBalance } from '@/features/wallet/assetTypes';
import type { WireOfferSummary } from '@/offscreen/vault';
import { bestSwapQuote, dexieCodeOf, validateSwapAmount, type SwapQuote } from '@/lib/swapQuote';
import { formatBaseUnits } from '@/lib/wallet-view';
import { legLabel } from '@/features/wallet/custody/offerLegFormat';
import {
  useBrowseDexieOffersQuery,
  usePrepareTradeMutation,
  useConfirmTradeMutation,
  useLazySendStatusQuery,
} from '@/features/wallet/custodyApi';

type Phase = 'pick' | 'review' | 'sending' | 'confirmed' | 'failed';

/** Map a wallet asset row → the fungible asset descriptor the dexie quoting engine expects (a
 * swap only ever deals in fungible XCH/CAT balances — never an NFT). */
function toFungibleAsset(a: AssetBalance): { kind: 'xch' } | { kind: 'cat'; assetId: string } {
  return a.descriptor.key === 'xch' || !a.descriptor.assetId ? { kind: 'xch' } : { kind: 'cat', assetId: a.descriptor.assetId };
}

/**
 * Token swap (#103, fullscreen-only advanced op per §6.4 — executing a swap is a real spend). A
 * "swap" here is a market order over dexie's public offer book (#102), NOT an AMM: pick what you're
 * paying + what you want, then TYPE how much of the pay asset you're willing to give up (#484's
 * amount-to-swap input) — this panel finds the best-rate currently-open offer that FITS that amount
 * (`bestSwapQuote`, pure client-side selection over dexie's already-existing search — display units
 * only), then hands the EXACT SAME `offer1…` string to the wallet's own take pipeline the Trade→Take
 * tab already uses. A dexie offer is all-or-nothing (this wallet's take pipeline can't partial-fill
 * one), so the entered amount is a CEILING that steers WHICH open offer gets matched — never a
 * placeholder, and never itself fed into the spend (`prepareTrade`/`confirmTrade` re-derive the real
 * base-unit amounts from the matched offer's raw bytes, fail-closed, exactly like a pasted/dropped
 * offer — the dexie-sourced quote numbers are informational only). `pollMs` is injectable for tests.
 */
export function SwapPanel({ assets, onDone, pollMs = 8000 }: { assets: AssetBalance[]; onDone: () => void; pollMs?: number }) {
  const intl = useIntl();
  const [phase, setPhase] = useState<Phase>('pick');
  const [sellIdx, setSellIdx] = useState(0);
  const [buyIdx, setBuyIdx] = useState(assets.length > 1 ? 1 : 0);
  // #484 — how much of the sell asset the user wants to swap (a decimal-string input, mirroring
  // Send/Trade's own amount fields). Reset whenever the sell asset changes: its decimals + balance
  // differ, so a prior amount could silently mean something else.
  const [amount, setAmount] = useState('');
  const [summary, setSummary] = useState<WireOfferSummary | null>(null);
  const [quoteUsed, setQuoteUsed] = useState<SwapQuote | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [spentCoinId, setSpentCoinId] = useState<string | null>(null);
  const [buildError, setBuildError] = useState<string | null>(null);

  const [prepareTrade, pt] = usePrepareTradeMutation();
  const [confirmTrade, ct] = useConfirmTradeMutation();
  const [pollStatus] = useLazySendStatusQuery();

  const sellAsset = assets[sellIdx] as AssetBalance | undefined;
  const buyAsset = assets[buyIdx] as AssetBalance | undefined;
  const sameAsset = sellIdx === buyIdx;
  const sellCode = sellAsset ? dexieCodeOf(toFungibleAsset(sellAsset)) : '';
  const buyCode = buyAsset ? dexieCodeOf(toFungibleAsset(buyAsset)) : '';
  const sellDecimals = sellAsset?.descriptor.decimals ?? 12;
  const sellSpendable = sellAsset?.balance ?? null;
  const sellTicker = sellAsset?.descriptor.ticker ?? '';

  // Full validation (numeric + precision + balance) gates the submit button; a blank field doesn't
  // show its "enter an amount" error until the user has actually typed something (no scolding before
  // interaction — mirrors Send's progressive-validation feel).
  const amountCheck = validateSwapAmount(amount, sellDecimals, sellSpendable);
  const amountValid = amountCheck.ok;
  const amountError = amount.trim() !== '' && !amountCheck.ok ? amountCheck.error : null;
  // A LIVE ceiling for quote selection reacts to every keystroke that parses as a positive number —
  // independent of the full `amountValid` gate — so the displayed quote updates as the user types,
  // even before the amount clears the balance/precision checks (submit itself still stays disabled
  // until `amountValid`, per the acceptance bar).
  const typedAmount = Number(amount.trim());
  const desiredSellAmount = amount.trim() !== '' && Number.isFinite(typedAmount) && typedAmount > 0 ? typedAmount : undefined;

  const browse = useBrowseDexieOffersQuery(
    { offered: buyCode, requested: sellCode },
    { skip: phase !== 'pick' || !sellCode || !buyCode || sameAsset },
  );
  const quote = useMemo(
    () => (browse.data ? bestSwapQuote(browse.data.offers, sellCode, buyCode, desiredSellAmount) : null),
    [browse.data, sellCode, buyCode, desiredSellAmount],
  );

  function setMaxAmount() {
    if (!sellAsset) return;
    setAmount(formatBaseUnits(sellAsset.balance ?? 0, sellDecimals));
  }

  async function doReview() {
    // Defense in depth (mirrors SendPanel's `poisonBlocked` guard): the button is already disabled
    // while the amount is invalid, but this also protects an Enter-key submit from bypassing it.
    if (!quote || !amountValid) return;
    setBuildError(null);
    const res = await prepareTrade({ offerStr: quote.offerStr, tradeKind: 'take' });
    if ('data' in res && res.data?.pendingId) {
      setPendingId(res.data.pendingId);
      setSummary(res.data.offerSummary);
      setQuoteUsed(quote);
      setPhase('review');
    } else {
      setBuildError(intl.formatMessage({ id: 'swap.error.build' }));
    }
  }

  async function doConfirm() {
    if (!pendingId) return;
    setPhase('sending');
    const res = await confirmTrade({ pendingId });
    if ('data' in res && res.data?.spentCoinId) {
      setSpentCoinId(res.data.spentCoinId);
    } else {
      setPhase('failed');
    }
  }

  // Poll to a terminal state once broadcast (an input coin recorded spent = confirmed).
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

  const busy = pt.isLoading || ct.isLoading;

  if (assets.length < 2) {
    return (
      <section className="dig-card" data-testid="swap-panel" aria-labelledby="swap-title">
        <button type="button" className="dig-link" data-testid="swap-back" onClick={onDone}>
          <FormattedMessage id="swap.back" />
        </button>
        <h2 className="dig-heading" id="swap-title" style={{ marginTop: 8 }}>
          <FormattedMessage id="swap.title" />
        </h2>
        <p className="dig-muted" data-testid="swap-needs-asset">
          <FormattedMessage id="swap.needsAsset" />
        </p>
      </section>
    );
  }

  return (
    <section className="dig-card" data-testid="swap-panel" aria-labelledby="swap-title">
      <button type="button" className="dig-link" data-testid="swap-back" onClick={onDone}>
        <FormattedMessage id="swap.back" />
      </button>
      <h2 className="dig-heading" id="swap-title" style={{ marginTop: 8 }}>
        <FormattedMessage id="swap.title" />
      </h2>

      {phase === 'pick' && (
        <div data-testid="swap-pick">
          <p className="dig-muted" style={{ marginTop: 0 }}>
            <FormattedMessage id="swap.intro" />
          </p>

          <label className="dig-field">
            <span><FormattedMessage id="swap.pay" /></span>
            <select
              className="dig-input"
              data-testid="swap-pay-asset"
              value={sellIdx}
              onChange={(e) => {
                setSellIdx(Number(e.target.value));
                setAmount(''); // decimals + balance differ per asset — a prior amount could mean something else
              }}
            >
              {assets.map((a, i) => (
                <option key={`pay-${a.descriptor.key}${a.descriptor.assetId ?? ''}`} value={i}>{a.descriptor.ticker}</option>
              ))}
            </select>
          </label>

          {/* #484 — the amount-to-swap input: the quantity of the PAY asset the user wants to give
              up. Drives which open dexie offer gets matched (an offer is all-or-nothing, so this is
              a ceiling — see `bestSwapQuote`'s module doc) and gates the review/submit button. */}
          <label className="dig-field">
            <span><FormattedMessage id="swap.amount" /> ({sellTicker})</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                data-testid="swap-amount"
                className="dig-input"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                inputMode="decimal"
                aria-describedby={amountError ? 'swap-amount-error' : 'swap-amount-balance'}
              />
              <button type="button" className="dig-btn" data-testid="swap-amount-max" onClick={setMaxAmount}>
                <FormattedMessage id="swap.amount.max" />
              </button>
            </div>
          </label>
          <p className="dig-muted" id="swap-amount-balance" data-testid="swap-amount-balance" style={{ margin: '-6px 0 8px', fontSize: '0.85em' }}>
            <FormattedMessage id="swap.amount.balance" values={{ amount: formatBaseUnits(sellSpendable, sellDecimals), ticker: sellTicker }} />
          </p>
          {amountError && (
            <p className="dig-error-text" role="alert" id="swap-amount-error" data-testid="swap-amount-error">
              <FormattedMessage id={amountError} />
            </p>
          )}

          <label className="dig-field">
            <span><FormattedMessage id="swap.receive" /></span>
            <select
              className="dig-input"
              data-testid="swap-receive-asset"
              value={buyIdx}
              onChange={(e) => setBuyIdx(Number(e.target.value))}
            >
              {assets.map((a, i) => (
                <option key={`recv-${a.descriptor.key}${a.descriptor.assetId ?? ''}`} value={i}>{a.descriptor.ticker}</option>
              ))}
            </select>
          </label>

          {sameAsset ? (
            <p className="dig-error-text" role="alert" data-testid="swap-same-asset-error">
              <FormattedMessage id="swap.error.sameAsset" />
            </p>
          ) : (
            <FourState
              isLoading={browse.isLoading || browse.isFetching}
              isError={browse.isError}
              isEmpty={!browse.isLoading && !browse.isFetching && !browse.isError && !quote}
              onRetry={() => void browse.refetch()}
              testid="swap-quote"
              emptyId="swap.quote.empty"
              errorId="swap.quote.error"
            >
              {quote && (
                <div data-testid="swap-quote-result">
                  <dl className="dig-summary">
                    <dt><FormattedMessage id="swap.quote.pay" /></dt>
                    <dd data-testid="swap-quote-pay">{quote.sellAmount} {quote.sellCode}</dd>
                    <dt><FormattedMessage id="swap.quote.receive" /></dt>
                    <dd data-testid="swap-quote-receive">{quote.buyAmount} {quote.buyCode}</dd>
                    <dt><FormattedMessage id="swap.quote.rate" /></dt>
                    <dd data-testid="swap-quote-rate">{quote.rate} {quote.buyCode}/{quote.sellCode}</dd>
                  </dl>
                  {buildError && <p className="dig-error-text" role="alert" data-testid="swap-build-error">{buildError}</p>}
                  <button type="button" className="dig-btn dig-btn--primary dig-btn--block" data-testid="swap-review" onClick={() => void doReview()} disabled={busy || !amountValid}>
                    <FormattedMessage id={busy ? 'custody.working' : 'swap.review'} />
                  </button>
                </div>
              )}
            </FourState>
          )}
        </div>
      )}

      {phase === 'review' && summary && quoteUsed && (
        <div data-testid="swap-review-panel">
          <p className="dig-muted" style={{ marginTop: 0 }}>
            <FormattedMessage id="swap.review.intro" />
          </p>
          <dl className="dig-summary">
            <dt><FormattedMessage id="swap.review.pay" /></dt>
            <dd data-testid="swap-review-pay">{summary.requested.map((l) => legLabel(l)).join(', ') || '—'}</dd>
            <dt><FormattedMessage id="swap.review.receive" /></dt>
            <dd data-testid="swap-review-receive">{summary.offered.map((l) => legLabel(l)).join(', ') || '—'}</dd>
          </dl>
          <button type="button" className="dig-btn dig-btn--primary dig-btn--block" data-testid="swap-confirm" onClick={() => void doConfirm()} disabled={busy}>
            <FormattedMessage id={busy ? 'custody.working' : 'swap.confirm'} />
          </button>
          <button type="button" className="dig-link" data-testid="swap-edit" onClick={() => setPhase('pick')}>
            <FormattedMessage id="swap.edit" />
          </button>
        </div>
      )}

      {phase === 'sending' && (
        <div className="dig-state" data-state="loading" role="status" data-testid="swap-sending">
          <FormattedMessage id="swap.sending" />
        </div>
      )}
      {phase === 'confirmed' && (
        <div className="dig-state" data-state="success" role="status" data-testid="swap-confirmed">
          <p><FormattedMessage id="swap.confirmed" /></p>
          <button type="button" className="dig-btn dig-btn--block" data-testid="swap-done" onClick={onDone}>
            <FormattedMessage id="swap.done" />
          </button>
        </div>
      )}
      {phase === 'failed' && (
        <div className="dig-state" data-state="error" role="alert" data-testid="swap-failed">
          <p><FormattedMessage id="swap.failed" /></p>
          <button type="button" className="dig-btn dig-btn--block" data-testid="swap-retry" onClick={() => setPhase('pick')}>
            <FormattedMessage id="state.retry" />
          </button>
        </div>
      )}
    </section>
  );
}
