import { useEffect, useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { formatBaseUnits } from '@/lib/wallet-view';
import { usePrepareCatIssuanceMutation, useConfirmCatIssuanceMutation, useLazySendStatusQuery } from '@/features/wallet/custodyApi';
import { CAT_DECIMALS } from '@/features/wallet/catMetadata';
import {
  validateCatIssuanceForm,
  EMPTY_CAT_ISSUANCE_FORM,
  type CatIssuanceForm,
  type CatIssuanceErrors,
} from '@/features/wallet/custody/catIssuanceForm';
import type { CatIssuanceSummary } from '@/offscreen/catIssuance';

const XCH_DECIMALS = 12;

type Phase = 'form' | 'review' | 'sending' | 'confirmed' | 'failed';

/**
 * Mint a brand-new CAT (#97, fullscreen-only advanced op per §6.4 — this constructs a real issuance
 * spend). A plain-language form (supply + single/multi issuance TAIL + optional network fee) → a
 * pre-sign review decoded FROM the built spend (what will be minted, the new asset id, the fee) →
 * confirm (sign in the offscreen vault + BROADCAST — the only real spend) → poll to confirmed/retry.
 * Poll reuses the shared `sendStatus` (an issuance is a coin spend). The decrypted key never leaves
 * the vault. `pollMs` is injectable for tests.
 */
export function CatIssuancePanel({ onDone, pollMs = 8000 }: { onDone: () => void; pollMs?: number }) {
  const intl = useIntl();
  const [phase, setPhase] = useState<Phase>('form');
  const [form, setForm] = useState<CatIssuanceForm>(EMPTY_CAT_ISSUANCE_FORM);
  const [errors, setErrors] = useState<CatIssuanceErrors>({});
  const [buildError, setBuildError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [summary, setSummary] = useState<CatIssuanceSummary | null>(null);
  const [assetId, setAssetId] = useState<string | null>(null);
  const [spentCoinId, setSpentCoinId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [prepareIssuance, prep] = usePrepareCatIssuanceMutation();
  const [confirmIssuance, conf] = useConfirmCatIssuanceMutation();
  const [pollStatus] = useLazySendStatusQuery();

  async function doPrepare() {
    const v = validateCatIssuanceForm(form);
    if (!v.ok) {
      setErrors(v.errors);
      return;
    }
    setErrors({});
    setBuildError(null);
    const res = await prepareIssuance({ catIssuance: v.params });
    if ('data' in res && res.data?.pendingId) {
      setPendingId(res.data.pendingId);
      setSummary(res.data.catIssuanceSummary);
      setAssetId(res.data.assetId);
      setPhase('review');
    } else {
      setBuildError(intl.formatMessage({ id: 'issue.error.build' }));
    }
  }

  async function doConfirm() {
    if (!pendingId) return;
    setPhase('sending');
    const res = await confirmIssuance({ pendingId });
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

  function copyAssetId() {
    if (!assetId) return;
    void navigator.clipboard?.writeText(assetId).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => setCopied(false),
    );
  }

  const busy = prep.isLoading || conf.isLoading;
  const err = (field: keyof CatIssuanceForm): string | null => (errors[field] ? intl.formatMessage({ id: errors[field] as string }) : null);

  return (
    <section className="dig-card" data-testid="cat-issuance-panel" aria-labelledby="cat-issuance-title">
      <button type="button" className="dig-link" data-testid="issue-back" onClick={onDone}>
        <FormattedMessage id="issue.back" />
      </button>
      <h2 className="dig-heading" id="cat-issuance-title" style={{ marginTop: 8 }}>
        <FormattedMessage id="issue.title" />
      </h2>

      {phase === 'form' && (
        <form
          data-testid="issue-form"
          onSubmit={(e) => {
            e.preventDefault();
            void doPrepare();
          }}
        >
          <p className="dig-muted" style={{ marginTop: 0 }}>
            <FormattedMessage id="issue.intro" />
          </p>

          <label className="dig-field">
            <span><FormattedMessage id="issue.supply" /></span>
            <span className="dig-muted" style={{ fontWeight: 400, fontSize: 11 }}>
              <FormattedMessage id="issue.supply.hint" values={{ decimals: CAT_DECIMALS }} />
            </span>
            <input
              data-testid="issue-supply"
              className="dig-input"
              inputMode="decimal"
              value={form.supply}
              onChange={(e) => setForm((f) => ({ ...f, supply: e.target.value }))}
              autoComplete="off"
              spellCheck={false}
              placeholder="1000000"
            />
            {err('supply') && <span className="dig-error-text" role="alert" data-testid="issue-supply-error">{err('supply')}</span>}
          </label>

          <div className="dig-field">
            <span><FormattedMessage id="issue.mode" /></span>
            <div className="dig-toggle-row" role="radiogroup" aria-label={intl.formatMessage({ id: 'issue.mode' })} style={{ display: 'flex', gap: 8, margin: '4px 0 4px' }}>
              <button
                type="button"
                role="radio"
                aria-checked={form.mode === 'single'}
                className={`dig-btn ${form.mode === 'single' ? 'dig-btn--primary' : ''}`}
                data-testid="issue-mode-single"
                onClick={() => setForm((f) => ({ ...f, mode: 'single' }))}
              >
                <FormattedMessage id="issue.mode.single" />
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={form.mode === 'multi'}
                className={`dig-btn ${form.mode === 'multi' ? 'dig-btn--primary' : ''}`}
                data-testid="issue-mode-multi"
                onClick={() => setForm((f) => ({ ...f, mode: 'multi' }))}
              >
                <FormattedMessage id="issue.mode.multi" />
              </button>
            </div>
            <span className="dig-muted" style={{ fontSize: 11 }}>
              <FormattedMessage id={form.mode === 'single' ? 'issue.mode.single.hint' : 'issue.mode.multi.hint'} />
            </span>
          </div>

          <label className="dig-field">
            <span><FormattedMessage id="issue.fee" /></span>
            <input
              data-testid="issue-fee"
              className="dig-input"
              inputMode="decimal"
              value={form.fee}
              onChange={(e) => setForm((f) => ({ ...f, fee: e.target.value }))}
              autoComplete="off"
              spellCheck={false}
              placeholder="0"
            />
            {err('fee') && <span className="dig-error-text" role="alert" data-testid="issue-fee-error">{err('fee')}</span>}
          </label>

          {buildError && <p className="dig-error-text" role="alert" data-testid="issue-build-error">{buildError}</p>}
          <button type="submit" className="dig-btn dig-btn--primary dig-btn--block" data-testid="issue-review" disabled={busy}>
            <FormattedMessage id={busy ? 'custody.working' : 'issue.review'} />
          </button>
        </form>
      )}

      {phase === 'review' && summary && (
        <div data-testid="issue-review-panel">
          <p className="dig-muted" style={{ marginTop: 0 }}>
            <FormattedMessage id="issue.review.intro" />
          </p>
          <dl className="dig-summary">
            <dt><FormattedMessage id="issue.review.supply" /></dt>
            <dd data-testid="issue-review-supply">{formatBaseUnits(summary.amount, CAT_DECIMALS)}</dd>
            <dt><FormattedMessage id="issue.review.mode" /></dt>
            <dd data-testid="issue-review-mode"><FormattedMessage id={summary.mode === 'single' ? 'issue.mode.single' : 'issue.mode.multi'} /></dd>
            <dt><FormattedMessage id="issue.review.assetId" /></dt>
            <dd className="dig-mono" data-testid="issue-review-asset-id" style={{ wordBreak: 'break-all', fontSize: 11 }}>{assetId}</dd>
            <dt><FormattedMessage id="issue.review.fee" /></dt>
            <dd data-testid="issue-review-fee">{formatBaseUnits(summary.fee, XCH_DECIMALS)} XCH</dd>
          </dl>
          <button type="button" className="dig-btn dig-btn--primary dig-btn--block" data-testid="issue-confirm" onClick={() => void doConfirm()} disabled={busy}>
            <FormattedMessage id="issue.confirm" />
          </button>
          <button type="button" className="dig-link" data-testid="issue-edit" onClick={() => setPhase('form')}>
            <FormattedMessage id="issue.edit" />
          </button>
        </div>
      )}

      {phase === 'sending' && (
        <div className="dig-state" data-state="loading" role="status" data-testid="issue-sending">
          <FormattedMessage id="issue.sending" />
        </div>
      )}
      {phase === 'confirmed' && (
        <div className="dig-state" data-state="success" role="status" data-testid="issue-confirmed">
          <p><FormattedMessage id="issue.confirmed" /></p>
          {assetId && (
            <>
              <p className="dig-mono" data-testid="issue-confirmed-asset-id" style={{ wordBreak: 'break-all', fontSize: 11 }}>{assetId}</p>
              <button type="button" className="dig-btn" data-testid="issue-copy-asset-id" onClick={copyAssetId}>
                <FormattedMessage id={copied ? 'trade.deal.copied' : 'issue.copyAssetId'} />
              </button>
            </>
          )}
          <button type="button" className="dig-btn dig-btn--block" data-testid="issue-done" onClick={onDone} style={{ marginTop: 8 }}>
            <FormattedMessage id="issue.done" />
          </button>
        </div>
      )}
      {phase === 'failed' && (
        <div className="dig-state" data-state="error" role="alert" data-testid="issue-failed">
          <p><FormattedMessage id="issue.failed" /></p>
          <button type="button" className="dig-btn dig-btn--block" data-testid="issue-retry" onClick={() => setPhase('form')}>
            <FormattedMessage id="state.retry" />
          </button>
        </div>
      )}
    </section>
  );
}
