import { useEffect, useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { toBaseUnits, formatBaseUnits, validateSendForm } from '#shared/wallet-view.mjs';
import { usePrepareSendMutation, useConfirmSendMutation, useLazySendStatusQuery, type PreparedSend } from '@/features/wallet/custodyApi';

const XCH_DECIMALS = 12;

type Phase = 'form' | 'review' | 'sending' | 'confirmed' | 'failed';

/**
 * Self-custody XCH Send (§6). A state machine: form (recipient + amount + Max + fee) → review (the
 * decoded, tamper-resistant summary from the built spend) → confirm (sign + BROADCAST — the only
 * real spend) → optimistic "Sending…" → poll → Confirmed / Not-confirmed-retry. Four states;
 * react-intl copy; the key never leaves the offscreen vault. `pollMs` is injectable for tests.
 */
export function SendPanel({
  spendableMojos,
  onClose,
  pollMs = 8000,
}: {
  spendableMojos: number | null;
  onClose?: () => void;
  pollMs?: number;
}) {
  const intl = useIntl();
  const [phase, setPhase] = useState<Phase>('form');
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [fee, setFee] = useState('0');
  const [localError, setLocalError] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<PreparedSend | null>(null);
  const [spentCoinId, setSpentCoinId] = useState<string | null>(null);

  const [prepareSend, prep] = usePrepareSendMutation();
  const [confirmSend, conf] = useConfirmSendMutation();
  const [pollStatus] = useLazySendStatusQuery();

  const feeMojos = safeBaseUnits(fee);
  const spendable = spendableMojos ?? 0;

  function setMax() {
    const max = Math.max(0, spendable - feeMojos);
    setAmount(formatBaseUnits(max, XCH_DECIMALS));
  }

  async function doPrepare() {
    const v = validateSendForm({ address: recipient, amount, fee });
    if (!v.ok) {
      setLocalError(v.errors.address || v.errors.amount || v.errors.fee || intl.formatMessage({ id: 'send.error.amount' }));
      return;
    }
    const amountMojos = safeBaseUnits(amount);
    if (amountMojos + feeMojos > spendable) {
      setLocalError(intl.formatMessage({ id: 'send.error.insufficient' }));
      return;
    }
    setLocalError(null);
    const res = await prepareSend({ recipient, amount: String(amountMojos), fee: String(feeMojos) });
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
            <span><FormattedMessage id="send.recipient" /></span>
            <input data-testid="send-recipient" className="dig-input dig-mono" value={recipient} onChange={(e) => setRecipient(e.target.value)} autoComplete="off" spellCheck={false} placeholder="xch1…" />
          </label>
          <label className="dig-field">
            <span><FormattedMessage id="send.amount" /> (XCH)</span>
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
            <dd data-testid="review-sent">{formatBaseUnits(Number(prepared.summary.sent), XCH_DECIMALS)} XCH</dd>
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

/** Parse a decimal XCH amount to mojos; 0 on garbage (validation catches bad input separately). */
function safeBaseUnits(value: string): number {
  try {
    const n = toBaseUnits(value || '0', XCH_DECIMALS);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}
