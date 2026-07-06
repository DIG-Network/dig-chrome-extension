import { useEffect, useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { toBaseUnits, formatBaseUnits, validateSendForm } from '@/lib/wallet-view';
import type { AssetBalance } from '@/features/wallet/assetTypes';
import { usePrepareSendMutation, useConfirmSendMutation, useLazySendStatusQuery, type PreparedSend } from '@/features/wallet/custodyApi';

const XCH_DECIMALS = 12;

type Phase = 'form' | 'review' | 'sending' | 'confirmed' | 'failed';

/**
 * Self-custody Send (§6) for XCH + CATs. A state machine: form (asset picker + recipient + amount +
 * Max + fee) → review (the decoded, tamper-resistant summary from the built spend) → confirm (sign +
 * BROADCAST — the only real spend) → optimistic "Sending…" → poll → Confirmed / Not-confirmed-retry.
 * Amounts use the selected asset's decimals; the fee is always XCH. `pollMs` is injectable for tests.
 */
export function SendPanel({
  assets,
  onClose,
  pollMs = 8000,
}: {
  assets: AssetBalance[];
  onClose?: () => void;
  pollMs?: number;
}) {
  const intl = useIntl();
  const [phase, setPhase] = useState<Phase>('form');
  const [assetIdx, setAssetIdx] = useState(0);
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [fee, setFee] = useState('0');
  const [localError, setLocalError] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<PreparedSend | null>(null);
  const [spentCoinId, setSpentCoinId] = useState<string | null>(null);

  const [prepareSend, prep] = usePrepareSendMutation();
  const [confirmSend, conf] = useConfirmSendMutation();
  const [pollStatus] = useLazySendStatusQuery();

  const selected = assets[assetIdx] ?? assets[0];
  const decimals = selected?.descriptor.decimals ?? XCH_DECIMALS;
  const ticker = selected?.descriptor.ticker ?? 'XCH';
  const assetId = selected?.descriptor.assetId ?? null; // null → native XCH
  const isXch = !assetId;
  const spendable = selected?.balance ?? 0;
  const feeMojos = safeBaseUnits(fee, XCH_DECIMALS);

  function setMax() {
    // XCH: leave room for the fee. CAT: the fee is paid in XCH, so Max is the full token balance.
    const max = isXch ? Math.max(0, spendable - feeMojos) : spendable;
    setAmount(formatBaseUnits(max, decimals));
  }

  async function doPrepare() {
    const v = validateSendForm({ address: recipient, amount, fee });
    if (!v.ok) {
      setLocalError(v.errors.address || v.errors.amount || v.errors.fee || intl.formatMessage({ id: 'send.error.amount' }));
      return;
    }
    const amountBase = safeBaseUnits(amount, decimals);
    const overspend = isXch ? amountBase + feeMojos > spendable : amountBase > spendable;
    if (overspend) {
      setLocalError(intl.formatMessage({ id: 'send.error.insufficient' }));
      return;
    }
    setLocalError(null);
    const res = await prepareSend({
      recipient,
      amount: String(amountBase),
      fee: String(feeMojos),
      ...(assetId ? { assetId } : {}),
    });
    if ('data' in res && res.data?.pendingId) {
      setPrepared(res.data);
      setPhase('review');
    } else {
      setLocalError(intl.formatMessage({ id: 'send.error.build' }));
    }
  }

  async function doConfirm() {
    if (!prepared) return;
    setPhase('sending');
    const res = await confirmSend({ pendingId: prepared.pendingId });
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

  const busy = prep.isLoading || conf.isLoading;

  return (
    <section className="dig-card" data-testid="custody-send" aria-labelledby="send-title">
      <h2 className="dig-heading" id="send-title">
        <FormattedMessage id="send.title" />
      </h2>

      {phase === 'form' && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void doPrepare();
          }}
        >
          <label className="dig-field">
            <span><FormattedMessage id="send.asset" /></span>
            <select
              data-testid="send-asset"
              className="dig-input"
              value={assetIdx}
              onChange={(e) => {
                setAssetIdx(Number(e.target.value));
                setAmount('');
              }}
            >
              {assets.map((a, i) => (
                <option key={a.descriptor.key + (a.descriptor.assetId ?? '')} value={i}>
                  {a.descriptor.ticker} — {a.label}
                </option>
              ))}
            </select>
          </label>
          <label className="dig-field">
            <span><FormattedMessage id="send.recipient" /></span>
            <input data-testid="send-recipient" className="dig-input dig-mono" value={recipient} onChange={(e) => setRecipient(e.target.value)} autoComplete="off" spellCheck={false} placeholder="xch1…" />
          </label>
          <label className="dig-field">
            <span><FormattedMessage id="send.amount" /> ({ticker})</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <input data-testid="send-amount" className="dig-input" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
              <button type="button" className="dig-btn" data-testid="send-max" onClick={setMax}>
                <FormattedMessage id="send.max" />
              </button>
            </div>
          </label>
          <label className="dig-field">
            <span><FormattedMessage id="send.fee" /></span>
            <input data-testid="send-fee" className="dig-input" value={fee} onChange={(e) => setFee(e.target.value)} inputMode="decimal" />
          </label>
          {localError && <p className="dig-error-text" role="alert" data-testid="send-error">{localError}</p>}
          <button type="submit" className="dig-btn dig-btn--primary dig-btn--block" data-testid="send-review" disabled={busy}>
            <FormattedMessage id={busy ? 'custody.working' : 'send.submit'} />
          </button>
          {onClose && (
            <button type="button" className="dig-link" data-testid="send-cancel" onClick={onClose}>
              <FormattedMessage id="send.cancel" />
            </button>
          )}
        </form>
      )}

      {phase === 'review' && prepared && (
        <div data-testid="send-review-panel">
          <p className="dig-muted" style={{ marginTop: 0 }}>
            <FormattedMessage id="send.review.intro" />
          </p>
          <dl className="dig-summary">
            <dt><FormattedMessage id="send.review.amount" /></dt>
            <dd data-testid="review-sent">{formatBaseUnits(Number(prepared.summary.sent), decimals)} {ticker}</dd>
            <dt><FormattedMessage id="send.review.fee" /></dt>
            <dd data-testid="review-fee">{formatBaseUnits(Number(prepared.summary.fee), XCH_DECIMALS)} XCH</dd>
            <dt><FormattedMessage id="send.review.recipient" /></dt>
            <dd className="dig-mono" data-testid="review-recipient">{recipient}</dd>
          </dl>
          <button type="button" className="dig-btn dig-btn--primary dig-btn--block" data-testid="send-confirm" onClick={() => void doConfirm()} disabled={busy}>
            <FormattedMessage id="send.confirm" />
          </button>
          <button type="button" className="dig-link" data-testid="send-back" onClick={() => setPhase('form')}>
            <FormattedMessage id="send.back" />
          </button>
        </div>
      )}

      {phase === 'sending' && (
        <div className="dig-state" data-state="loading" role="status" data-testid="send-sending">
          <FormattedMessage id="send.sending" />
        </div>
      )}
      {phase === 'confirmed' && (
        <div className="dig-state" data-state="success" role="status" data-testid="send-confirmed">
          <p><FormattedMessage id="send.confirmed" /></p>
          {onClose && (
            <button type="button" className="dig-btn dig-btn--block" data-testid="send-done" onClick={onClose}>
              <FormattedMessage id="send.done" />
            </button>
          )}
        </div>
      )}
      {phase === 'failed' && (
        <div className="dig-state" data-state="error" role="alert" data-testid="send-failed">
          <p><FormattedMessage id="send.failed" /></p>
          <button type="button" className="dig-btn dig-btn--block" data-testid="send-retry" onClick={() => setPhase('form')}>
            <FormattedMessage id="state.retry" />
          </button>
        </div>
      )}
    </section>
  );
}

/** Parse a decimal amount to base units for the given decimals; 0 on garbage (validation catches it). */
function safeBaseUnits(value: string, decimals: number): number {
  try {
    const n = toBaseUnits(value || '0', decimals);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}
