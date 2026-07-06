import { useEffect, useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { formatBaseUnits, toBaseUnits } from '@/lib/wallet-view';
import { usePrepareDidCreateMutation, useConfirmDidCreateMutation } from '@/features/identity/identityApi';
import { useLazySendStatusQuery } from '@/features/wallet/custodyApi';

const XCH_DECIMALS = 12;

type Phase = 'form' | 'review' | 'sending' | 'confirmed' | 'failed';

/**
 * Create a new "simple" DID (#93) — a plain-language form (an optional network fee) → a pre-sign
 * review decoded FROM the built spend (the fee that will be reserved) → confirm (sign in the
 * offscreen vault + BROADCAST — the only real spend) → poll to confirmed/retry. Poll reuses the
 * shared `sendStatus` (a DID create is a coin spend). The new DID then appears in the Identity list
 * (the mutation invalidates the `Identity` cache). The decrypted key never leaves the vault. `pollMs`
 * is injectable for tests. Fullscreen-only surface (§145) — rendered only from `DidPanel` when full.
 */
export function CreateDid({ onDone, pollMs = 8000 }: { onDone: () => void; pollMs?: number }) {
  const intl = useIntl();
  const [phase, setPhase] = useState<Phase>('form');
  const [fee, setFee] = useState('0');
  const [feeError, setFeeError] = useState<string | null>(null);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [launcherId, setLauncherId] = useState<string | null>(null);
  const [feeSummary, setFeeSummary] = useState('0');
  const [spentCoinId, setSpentCoinId] = useState<string | null>(null);

  const [prepareCreate, prep] = usePrepareDidCreateMutation();
  const [confirmCreate, conf] = useConfirmDidCreateMutation();
  const [pollStatus] = useLazySendStatusQuery();

  function parseFee(): number | null {
    const trimmed = fee.trim();
    if (trimmed === '') return 0;
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n < 0) return null;
    if (n === 0) return 0;
    try {
      const mojos = toBaseUnits(trimmed, XCH_DECIMALS);
      return Number.isFinite(mojos) && mojos >= 0 ? mojos : null;
    } catch {
      return null;
    }
  }

  async function doPrepare() {
    const feeMojos = parseFee();
    if (feeMojos === null) {
      setFeeError(intl.formatMessage({ id: 'did.create.error.fee' }));
      return;
    }
    setFeeError(null);
    setBuildError(null);
    const res = await prepareCreate({ fee: String(feeMojos) });
    if ('data' in res && res.data?.pendingId) {
      setPendingId(res.data.pendingId);
      setLauncherId(res.data.launcherId);
      setFeeSummary(res.data.didCreateSummary.fee);
      setPhase('review');
    } else {
      setBuildError(intl.formatMessage({ id: 'did.create.error.build' }));
    }
  }

  async function doConfirm() {
    if (!pendingId) return;
    setPhase('sending');
    const res = await confirmCreate({ pendingId });
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
    <section className="dig-card" data-testid="did-create" aria-labelledby="did-create-title">
      <button type="button" className="dig-link" data-testid="did-create-back" onClick={onDone}>
        <FormattedMessage id="did.create.back" />
      </button>
      <h2 className="dig-heading" id="did-create-title" style={{ marginTop: 8 }}>
        <FormattedMessage id="did.create.title" />
      </h2>

      {phase === 'form' && (
        <form
          data-testid="did-create-form"
          onSubmit={(e) => {
            e.preventDefault();
            void doPrepare();
          }}
        >
          <p className="dig-muted" style={{ marginTop: 0 }}>
            <FormattedMessage id="did.create.intro" />
          </p>
          <label className="dig-field">
            <span><FormattedMessage id="did.create.fee" /></span>
            <input
              data-testid="did-create-fee"
              className="dig-input"
              value={fee}
              onChange={(e) => setFee(e.target.value)}
              inputMode="decimal"
              placeholder="0"
            />
            {feeError && <span className="dig-error-text" role="alert" data-testid="did-create-fee-error">{feeError}</span>}
          </label>
          {buildError && <p className="dig-error-text" role="alert" data-testid="did-create-build-error">{buildError}</p>}
          <button type="submit" className="dig-btn dig-btn--primary dig-btn--block" data-testid="did-create-review" disabled={busy}>
            <FormattedMessage id={busy ? 'custody.working' : 'did.create.review'} />
          </button>
        </form>
      )}

      {phase === 'review' && (
        <div data-testid="did-create-review-panel">
          <p className="dig-muted" style={{ marginTop: 0 }}>
            <FormattedMessage id="did.create.review.intro" />
          </p>
          <dl className="dig-summary">
            <dt><FormattedMessage id="did.create.review.fee" /></dt>
            <dd data-testid="did-create-review-fee">{formatBaseUnits(feeSummary, XCH_DECIMALS)} XCH</dd>
          </dl>
          <button type="button" className="dig-btn dig-btn--primary dig-btn--block" data-testid="did-create-confirm" onClick={() => void doConfirm()} disabled={busy}>
            <FormattedMessage id="did.create.confirm" />
          </button>
          <button type="button" className="dig-link" data-testid="did-create-edit" onClick={() => setPhase('form')}>
            <FormattedMessage id="did.create.edit" />
          </button>
        </div>
      )}

      {phase === 'sending' && (
        <div className="dig-state" data-state="loading" role="status" data-testid="did-create-sending">
          <FormattedMessage id="did.create.sending" />
        </div>
      )}
      {phase === 'confirmed' && (
        <div className="dig-state" data-state="success" role="status" data-testid="did-create-confirmed">
          <p><FormattedMessage id="did.create.confirmed" /></p>
          {launcherId && <p className="dig-mono" data-testid="did-create-launcher-id" style={{ wordBreak: 'break-all', fontSize: 11 }}>{launcherId}</p>}
          <button type="button" className="dig-btn dig-btn--block" data-testid="did-create-done" onClick={onDone}>
            <FormattedMessage id="did.create.done" />
          </button>
        </div>
      )}
      {phase === 'failed' && (
        <div className="dig-state" data-state="error" role="alert" data-testid="did-create-failed">
          <p><FormattedMessage id="did.create.failed" /></p>
          <button type="button" className="dig-btn dig-btn--block" data-testid="did-create-retry" onClick={() => setPhase('form')}>
            <FormattedMessage id="state.retry" />
          </button>
        </div>
      )}
    </section>
  );
}
