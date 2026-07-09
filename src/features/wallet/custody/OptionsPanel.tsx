import { useEffect, useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { formatBaseUnits } from '@/lib/wallet-view';
import { FourState } from '@/components/FourState';
import {
  usePrepareOptionMintMutation,
  useConfirmOptionMintMutation,
  usePrepareOptionExerciseMutation,
  useConfirmOptionExerciseMutation,
  useGetOptionsQuery,
  useLazySendStatusQuery,
} from '@/features/wallet/custodyApi';
import {
  validateOptionMintForm,
  EMPTY_OPTION_MINT_FORM,
  type OptionMintForm,
  type OptionMintErrors,
} from '@/features/wallet/custody/optionMintForm';
import type { OptionMintSummary, OptionRecord } from '@/offscreen/optionContracts';
import type { OptionLogEntry } from '@/lib/optionContractLog';

const XCH_DECIMALS = 12;

type Mode = 'mint' | 'list';
type MintPhase = 'form' | 'review' | 'sending' | 'confirmed' | 'failed';
type ExercisePhase = 'idle' | 'review' | 'sending' | 'confirmed' | 'failed';

/**
 * Option contracts — mint / list / exercise (#104, fullscreen-only advanced op per §6.4 — both mint
 * and exercise construct real spends). MVP is XCH-denominated only, self-mint/self-exercise (see
 * `optionContracts.ts`'s module doc for the scoping rationale). `pollMs` is injectable for tests.
 */
export function OptionsPanel({ onDone, pollMs = 8000 }: { onDone: () => void; pollMs?: number }) {
  const [mode, setMode] = useState<Mode>('mint');
  return (
    <section className="dig-card" data-testid="options-panel" aria-labelledby="options-title">
      <button type="button" className="dig-link" data-testid="options-back" onClick={onDone}>
        <FormattedMessage id="options.back" />
      </button>
      <h2 className="dig-heading" id="options-title" style={{ marginTop: 8 }}>
        <FormattedMessage id="options.title" />
      </h2>
      <div role="tablist" aria-label="Options" style={{ display: 'flex', gap: 8, margin: '4px 0 12px' }}>
        <button type="button" role="tab" aria-selected={mode === 'mint'} className={`dig-btn ${mode === 'mint' ? 'dig-btn--primary' : ''}`} data-testid="options-mode-mint" onClick={() => setMode('mint')}>
          <FormattedMessage id="options.mode.mint" />
        </button>
        <button type="button" role="tab" aria-selected={mode === 'list'} className={`dig-btn ${mode === 'list' ? 'dig-btn--primary' : ''}`} data-testid="options-mode-list" onClick={() => setMode('list')}>
          <FormattedMessage id="options.mode.list" />
        </button>
      </div>
      {mode === 'mint' && <MintOption pollMs={pollMs} />}
      {mode === 'list' && <ListOptions pollMs={pollMs} />}
    </section>
  );
}

/** MINT: form → review (decoded from the built spend) → confirm → sending → confirmed/retry. */
function MintOption({ pollMs }: { pollMs: number }) {
  const intl = useIntl();
  const [phase, setPhase] = useState<MintPhase>('form');
  const [form, setForm] = useState<OptionMintForm>(EMPTY_OPTION_MINT_FORM);
  const [errors, setErrors] = useState<OptionMintErrors>({});
  const [buildError, setBuildError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [summary, setSummary] = useState<OptionMintSummary | null>(null);
  const [record, setRecord] = useState<OptionRecord | null>(null);
  const [spentCoinId, setSpentCoinId] = useState<string | null>(null);

  const [prepareMint, prep] = usePrepareOptionMintMutation();
  const [confirmMint, conf] = useConfirmOptionMintMutation();
  const [pollStatus] = useLazySendStatusQuery();

  async function doPrepare() {
    const v = validateOptionMintForm(form);
    if (!v.ok) {
      setErrors(v.errors);
      return;
    }
    setErrors({});
    setBuildError(null);
    const res = await prepareMint({ optionMint: v.params });
    if ('data' in res && res.data?.pendingId) {
      setPendingId(res.data.pendingId);
      setSummary(res.data.optionMintSummary);
      setRecord(res.data.optionRecord);
      setPhase('review');
    } else {
      setBuildError(intl.formatMessage({ id: 'options.error.build' }));
    }
  }

  async function doConfirm() {
    if (!pendingId || !record) return;
    setPhase('sending');
    const res = await confirmMint({ pendingId, optionRecord: record });
    if ('data' in res && res.data?.spentCoinId) {
      setSpentCoinId(res.data.spentCoinId);
    } else {
      setPhase('failed');
    }
  }

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
  const err = (field: keyof OptionMintForm): string | null => (errors[field] ? intl.formatMessage({ id: errors[field] as string }) : null);

  if (phase === 'form') {
    return (
      <form
        data-testid="options-mint-form"
        onSubmit={(e) => {
          e.preventDefault();
          void doPrepare();
        }}
      >
        <p className="dig-muted" style={{ marginTop: 0 }}>
          <FormattedMessage id="options.mint.intro" />
        </p>
        <label className="dig-field">
          <span><FormattedMessage id="options.mint.underlying" /></span>
          <input
            data-testid="options-mint-underlying"
            className="dig-input"
            inputMode="decimal"
            value={form.underlyingXch}
            onChange={(e) => setForm((f) => ({ ...f, underlyingXch: e.target.value }))}
            placeholder="1"
          />
          {err('underlyingXch') && <span className="dig-error-text" role="alert" data-testid="options-mint-underlying-error">{err('underlyingXch')}</span>}
        </label>
        <label className="dig-field">
          <span><FormattedMessage id="options.mint.strike" /></span>
          <input
            data-testid="options-mint-strike"
            className="dig-input"
            inputMode="decimal"
            value={form.strikeXch}
            onChange={(e) => setForm((f) => ({ ...f, strikeXch: e.target.value }))}
            placeholder="0.5"
          />
          {err('strikeXch') && <span className="dig-error-text" role="alert" data-testid="options-mint-strike-error">{err('strikeXch')}</span>}
        </label>
        <label className="dig-field">
          <span><FormattedMessage id="options.mint.expires" /></span>
          <input
            data-testid="options-mint-expires"
            className="dig-input"
            inputMode="numeric"
            value={form.expiresInDays}
            onChange={(e) => setForm((f) => ({ ...f, expiresInDays: e.target.value }))}
            placeholder="30"
          />
          {err('expiresInDays') && <span className="dig-error-text" role="alert" data-testid="options-mint-expires-error">{err('expiresInDays')}</span>}
        </label>
        <label className="dig-field">
          <span><FormattedMessage id="issue.fee" /></span>
          <input
            data-testid="options-mint-fee"
            className="dig-input"
            inputMode="decimal"
            value={form.fee}
            onChange={(e) => setForm((f) => ({ ...f, fee: e.target.value }))}
            placeholder="0"
          />
          {err('fee') && <span className="dig-error-text" role="alert" data-testid="options-mint-fee-error">{err('fee')}</span>}
        </label>
        {buildError && <p className="dig-error-text" role="alert" data-testid="options-mint-build-error">{buildError}</p>}
        <button type="submit" className="dig-btn dig-btn--primary dig-btn--block" data-testid="options-mint-review" disabled={busy}>
          <FormattedMessage id={busy ? 'custody.working' : 'options.mint.review'} />
        </button>
      </form>
    );
  }

  if (phase === 'review' && summary) {
    return (
      <div data-testid="options-mint-review-panel">
        <p className="dig-muted" style={{ marginTop: 0 }}>
          <FormattedMessage id="options.mint.review.intro" />
        </p>
        <dl className="dig-summary">
          <dt><FormattedMessage id="options.mint.underlying" /></dt>
          <dd data-testid="options-mint-review-underlying">{formatBaseUnits(summary.underlyingAmount, XCH_DECIMALS)} XCH</dd>
          <dt><FormattedMessage id="options.mint.strike" /></dt>
          <dd data-testid="options-mint-review-strike">{formatBaseUnits(summary.strikeAmount, XCH_DECIMALS)} XCH</dd>
          <dt><FormattedMessage id="issue.review.fee" /></dt>
          <dd data-testid="options-mint-review-fee">{formatBaseUnits(summary.fee, XCH_DECIMALS)} XCH</dd>
        </dl>
        <button type="button" className="dig-btn dig-btn--primary dig-btn--block" data-testid="options-mint-confirm" onClick={() => void doConfirm()} disabled={busy}>
          <FormattedMessage id={busy ? 'custody.working' : 'options.mint.confirm'} />
        </button>
        <button type="button" className="dig-link" data-testid="options-mint-edit" onClick={() => setPhase('form')}>
          <FormattedMessage id="issue.edit" />
        </button>
      </div>
    );
  }

  if (phase === 'sending') {
    return (
      <div className="dig-state" data-state="loading" role="status" data-testid="options-mint-sending">
        <FormattedMessage id="options.mint.sending" />
      </div>
    );
  }
  if (phase === 'confirmed') {
    return (
      <div className="dig-state" data-state="success" role="status" data-testid="options-mint-confirmed">
        <p><FormattedMessage id="options.mint.confirmed" /></p>
        {record && <p className="dig-mono" data-testid="options-mint-launcher-id" style={{ wordBreak: 'break-all', fontSize: 11 }}>{record.launcherId}</p>}
        <button type="button" className="dig-btn dig-btn--block" data-testid="options-mint-done" onClick={() => setPhase('form')} style={{ marginTop: 8 }}>
          <FormattedMessage id="issue.done" />
        </button>
      </div>
    );
  }
  return (
    <div className="dig-state" data-state="error" role="alert" data-testid="options-mint-failed">
      <p><FormattedMessage id="options.mint.failed" /></p>
      <button type="button" className="dig-btn dig-btn--block" data-testid="options-mint-retry" onClick={() => setPhase('form')}>
        <FormattedMessage id="state.retry" />
      </button>
    </div>
  );
}

/** LIST: the local option registry (mint history) + an Exercise action for each still-open, not-yet-expired entry. */
function ListOptions({ pollMs }: { pollMs: number }) {
  const intl = useIntl();
  const options = useGetOptionsQuery();
  const [exercising, setExercising] = useState<string | null>(null); // launcherId currently being exercised
  const [exercisePhase, setExercisePhase] = useState<ExercisePhase>('idle');
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [spentCoinId, setSpentCoinId] = useState<string | null>(null);

  const [prepareExercise, pex] = usePrepareOptionExerciseMutation();
  const [confirmExercise, cex] = useConfirmOptionExerciseMutation();
  const [pollStatus] = useLazySendStatusQuery();

  async function doExercise(entry: OptionLogEntry) {
    setExercising(entry.record.launcherId);
    setExercisePhase('review');
    const res = await prepareExercise({ optionRecord: entry.record });
    if ('data' in res && res.data?.pendingId) {
      setPendingId(res.data.pendingId);
    } else {
      setExercisePhase('failed');
    }
  }

  async function doConfirmExercise() {
    if (!pendingId) return;
    setExercisePhase('sending');
    const res = await confirmExercise({ pendingId });
    if ('data' in res && res.data?.spentCoinId) {
      setSpentCoinId(res.data.spentCoinId);
    } else {
      setExercisePhase('failed');
    }
  }

  useEffect(() => {
    if (exercisePhase !== 'sending' || !spentCoinId) return;
    let live = true;
    const timer = setInterval(async () => {
      const res = await pollStatus({ coinId: spentCoinId });
      if (live && 'data' in res && res.data?.confirmed) {
        setExercisePhase('confirmed');
        clearInterval(timer);
      }
    }, pollMs);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [exercisePhase, spentCoinId, pollMs, pollStatus]);

  const nowSeconds = Math.floor(Date.now() / 1000);
  const busy = pex.isLoading || cex.isLoading;

  return (
    <div data-testid="options-list">
      <FourState
        isLoading={options.isLoading}
        isError={options.isError}
        isEmpty={!options.isLoading && !options.isError && (options.data?.options.length ?? 0) === 0}
        onRetry={() => void options.refetch()}
        testid="options-list"
        emptyId="options.list.empty"
      >
        <ul className="dig-list" data-testid="options-list-rows" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {(options.data?.options ?? []).map((entry) => {
            const expired = nowSeconds >= Number(entry.record.expirationSeconds);
            const canExercise = entry.status === 'open' && !expired;
            const isThisOne = exercising === entry.record.launcherId;
            return (
              <li key={entry.record.launcherId} className="dig-card" data-testid={`options-row-${entry.record.launcherId}`} style={{ marginBottom: 8 }}>
                <dl className="dig-summary">
                  <dt><FormattedMessage id="options.mint.underlying" /></dt>
                  <dd>{formatBaseUnits(entry.record.underlyingAmount, XCH_DECIMALS)} XCH</dd>
                  <dt><FormattedMessage id="options.mint.strike" /></dt>
                  <dd>{formatBaseUnits(entry.record.strikeAmount, XCH_DECIMALS)} XCH</dd>
                  <dt><FormattedMessage id="options.list.status" /></dt>
                  <dd data-testid={`options-row-status-${entry.record.launcherId}`}>
                    <FormattedMessage id={entry.status === 'open' ? (expired ? 'options.list.status.expired' : 'options.list.status.open') : 'options.list.status.exercised'} />
                  </dd>
                </dl>
                {canExercise && isThisOne && exercisePhase === 'review' && !pendingId && (
                  <p className="dig-muted" role="status">{intl.formatMessage({ id: 'custody.working' })}</p>
                )}
                {canExercise && isThisOne && exercisePhase === 'review' && pendingId && (
                  <button type="button" className="dig-btn dig-btn--primary" data-testid={`options-exercise-confirm-${entry.record.launcherId}`} onClick={() => void doConfirmExercise()} disabled={busy}>
                    <FormattedMessage id="options.exercise.confirm" />
                  </button>
                )}
                {canExercise && isThisOne && exercisePhase === 'sending' && (
                  <p className="dig-state" data-state="loading" role="status" data-testid="options-exercise-sending"><FormattedMessage id="options.exercise.sending" /></p>
                )}
                {canExercise && isThisOne && exercisePhase === 'confirmed' && (
                  <p className="dig-state" data-state="success" role="status" data-testid="options-exercise-confirmed"><FormattedMessage id="options.exercise.confirmed" /></p>
                )}
                {canExercise && isThisOne && exercisePhase === 'failed' && (
                  <p className="dig-error-text" role="alert" data-testid="options-exercise-failed"><FormattedMessage id="options.exercise.failed" /></p>
                )}
                {canExercise && (!isThisOne || exercisePhase === 'idle') && (
                  <button type="button" className="dig-btn" data-testid={`options-exercise-${entry.record.launcherId}`} onClick={() => void doExercise(entry)} disabled={busy}>
                    <FormattedMessage id="options.exercise.action" />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </FourState>
    </div>
  );
}
