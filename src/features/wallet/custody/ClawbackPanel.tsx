import { useEffect, useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { FourState } from '@/components/FourState';
import { ViewHeader } from '@/components/ViewHeader';
import { formatBaseUnits } from '@/lib/wallet-view';
import {
  useGetClawbacksQuery,
  usePrepareClawbackActionMutation,
  useConfirmClawbackActionMutation,
  useLazySendStatusQuery,
  type PendingClawback,
  type PreparedClawbackAction,
} from '@/features/wallet/custodyApi';

const XCH_DECIMALS = 12;

type Phase = 'list' | 'review' | 'sending' | 'confirmed' | 'failed';

/** True once `seconds` (an absolute unix timestamp) has passed, per the local clock (a UI convenience
 * only — the on-chain puzzle is the real enforcement; see `offscreen/clawback.ts`). */
function windowElapsed(secondsDecimal: string, nowMs: number): boolean {
  return nowMs >= Number(secondsDecimal) * 1000;
}

/**
 * Clawback (#152) — the FULLSCREEN-ONLY management surface (§145) for pending reclaimable sends: an
 * INCOMING list (coins sent to this wallet with a clawback window — claimable once the window
 * elapses) and an OUTGOING list (this wallet's own clawback sends — reclaimable strictly BEFORE the
 * window elapses; the cutover is a hard on-chain deadline, not a race, see `offscreen/clawback.ts`).
 * A single-flow state machine mirroring `CoinControlPanel`: list → review (the decoded amount to
 * approve) → sending → confirmed/failed. XCH only (v1). `pollMs`/`nowMs` are injectable for tests.
 */
export function ClawbackPanel({ onClose, pollMs = 8000, nowMs }: { onClose?: () => void; pollMs?: number; nowMs?: number }) {
  const intl = useIntl();
  const [phase, setPhase] = useState<Phase>('list');
  const [selected, setSelected] = useState<PendingClawback | null>(null);
  const [prepared, setPrepared] = useState<PreparedClawbackAction | null>(null);
  const [spentCoinId, setSpentCoinId] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const list = useGetClawbacksQuery();
  const [prepareAction, prep] = usePrepareClawbackActionMutation();
  const [confirmAction, conf] = useConfirmClawbackActionMutation();
  const [pollStatus] = useLazySendStatusQuery();

  const clawbacks = list.data?.clawbacks ?? [];
  const now = nowMs ?? Date.now();
  const busy = prep.isLoading || conf.isLoading;

  async function act(item: PendingClawback) {
    setLocalError(null);
    setSelected(item);
    const res = await prepareAction({ direction: item.direction === 'incoming' ? 'claim' : 'reclaim', clawbackInfo: item.info });
    if ('data' in res && res.data?.pendingId) {
      setPrepared(res.data);
      setPhase('review');
    } else {
      setLocalError(intl.formatMessage({ id: 'clawback.error.build' }));
    }
  }

  async function doConfirm() {
    if (!prepared) return;
    setPhase('sending');
    const res = await confirmAction({ pendingId: prepared.pendingId });
    if ('data' in res && res.data?.spentCoinId) setSpentCoinId(res.data.spentCoinId);
    else setPhase('failed');
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

  const headerBack = phase === 'sending' ? undefined : phase === 'review' ? () => setPhase('list') : onClose;
  const headerBackLabel = phase === 'review' ? <FormattedMessage id="send.back" /> : <FormattedMessage id="send.cancel" />;
  const headerBackTestId = phase === 'review' ? 'clawback-back' : 'clawback-close';

  return (
    <div data-testid="clawback-panel">
      <ViewHeader onBack={headerBack} backLabel={headerBackLabel} backTestId={headerBackTestId} title={<FormattedMessage id="clawback.title" />} titleId="clawback-title" />
      <section className="dig-card" aria-labelledby="clawback-title">
        {phase === 'list' && (
          <>
            <p className="dig-muted" style={{ marginTop: 0 }}>
              <FormattedMessage id="clawback.intro" />
            </p>
            <FourState
              isLoading={list.isLoading}
              isError={list.isError}
              isEmpty={!list.isLoading && !list.isError && clawbacks.length === 0}
              onRetry={() => void list.refetch()}
              testid="clawback-list"
              emptyId="clawback.empty"
              errorId="clawback.error"
            >
              <ul data-testid="clawback-items" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {clawbacks.map((c) => {
                  const elapsed = windowElapsed(c.info.seconds, now);
                  const actionable = c.direction === 'incoming' ? elapsed : !elapsed;
                  const when = intl.formatDate(Number(c.info.seconds) * 1000, { dateStyle: 'medium', timeStyle: 'short' });
                  return (
                    <li
                      key={c.coinIdHex}
                      data-testid={`clawback-row-${c.coinIdHex}`}
                      data-direction={c.direction}
                      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0', borderBottom: '1px solid var(--dig-border)' }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600 }}>
                          {formatBaseUnits(Number(c.info.amount), XCH_DECIMALS)} XCH ·{' '}
                          <FormattedMessage id={c.direction === 'incoming' ? 'clawback.direction.incoming' : 'clawback.direction.outgoing'} />
                        </div>
                        <div className="dig-muted" style={{ fontSize: '0.85em' }} data-testid={`clawback-status-${c.coinIdHex}`}>
                          <FormattedMessage
                            id={
                              c.direction === 'incoming'
                                ? elapsed
                                  ? 'clawback.status.claimableNow'
                                  : 'clawback.status.claimableAfter'
                                : elapsed
                                  ? 'clawback.status.windowElapsed'
                                  : 'clawback.status.reclaimableUntil'
                            }
                            values={{ when }}
                          />
                        </div>
                      </div>
                      <button
                        type="button"
                        className="dig-btn dig-btn--primary"
                        data-testid={`clawback-action-${c.coinIdHex}`}
                        disabled={busy || !actionable}
                        onClick={() => void act(c)}
                      >
                        <FormattedMessage id={c.direction === 'incoming' ? 'clawback.action.claim' : 'clawback.action.reclaim'} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </FourState>
            {localError && (
              <p className="dig-error-text" role="alert" data-testid="clawback-error" style={{ marginTop: 8 }}>
                {localError}
              </p>
            )}
          </>
        )}

        {phase === 'review' && prepared && selected && (
          <div data-testid="clawback-review">
            <p className="dig-muted" style={{ marginTop: 0 }}>
              <FormattedMessage id={selected.direction === 'incoming' ? 'clawback.review.introClaim' : 'clawback.review.introReclaim'} />
            </p>
            <dl className="dig-summary">
              <dt>
                <FormattedMessage id="send.review.amount" />
              </dt>
              <dd data-testid="clawback-review-amount">{formatBaseUnits(Number(prepared.clawbackAmountOut), XCH_DECIMALS)} XCH</dd>
            </dl>
            <button type="button" className="dig-btn dig-btn--primary dig-btn--block" data-testid="clawback-confirm" onClick={() => void doConfirm()} disabled={busy}>
              <FormattedMessage id={selected.direction === 'incoming' ? 'clawback.action.claim' : 'clawback.action.reclaim'} />
            </button>
          </div>
        )}

        {phase === 'sending' && (
          <div className="dig-state" data-state="loading" role="status" data-testid="clawback-sending">
            <FormattedMessage id="clawback.sending" />
          </div>
        )}
        {phase === 'confirmed' && (
          <div className="dig-state" data-state="success" role="status" data-testid="clawback-confirmed">
            <p>
              <FormattedMessage id="clawback.confirmed" />
            </p>
            <button
              type="button"
              className="dig-btn dig-btn--block"
              data-testid="clawback-done"
              onClick={() => {
                setSelected(null);
                setPrepared(null);
                setSpentCoinId(null);
                setPhase('list');
              }}
            >
              <FormattedMessage id="send.done" />
            </button>
          </div>
        )}
        {phase === 'failed' && (
          <div className="dig-state" data-state="error" role="alert" data-testid="clawback-failed">
            <p>
              <FormattedMessage id="clawback.failed" />
            </p>
            <button type="button" className="dig-btn dig-btn--block" data-testid="clawback-retry" onClick={() => setPhase('list')}>
              <FormattedMessage id="state.retry" />
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
