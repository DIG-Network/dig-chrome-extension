import { useState } from 'react';
import { FormattedMessage } from 'react-intl';
import { FourState } from '@/components/FourState';
import { StatusPill, type PillTone } from '@/components/StatusPill';
import {
  useGetAppSignStatusQuery,
  usePairAppSignMutation,
  useUnpairAppSignMutation,
  type AppSignStatus,
} from '@/features/security/appSignApi';

/** The pill tone + label for the current APP-SIGN posture. */
function postureMeta(status: AppSignStatus): { tone: PillTone; labelId: string } {
  if (status.connState !== 'connected') return { tone: 'warn', labelId: 'appSign.state.appDown' };
  if (status.paired) return { tone: 'good', labelId: 'appSign.state.paired' };
  return { tone: 'neutral', labelId: 'appSign.state.notPaired' };
}

/**
 * The **dig-app pairing** section (SIGN-4, #950; dig-app `SPEC.md §5.6`). Surfaces whether this
 * extension is paired with the dig-app identity agent and whether that loopback channel is live, and
 * lets the user pair (a one-time native confirm dig-app raises) or unpair.
 *
 * dig-app — not the extension — holds the user key and raises the terminal biometric confirm on every
 * sign; this section only manages the pairing lifecycle + shows the channel posture. It is dig-app-
 * dependent (independent of the dig-node control pairing), so a "dig-app not running" state renders
 * honestly with a way to retry rather than trapping the user. Presentational shell around the
 * {@link appSignApi} query/mutations.
 */
export function AppSignPairingSection() {
  const status = useGetAppSignStatusQuery();
  const [pair, pairState] = usePairAppSignMutation();
  const [unpair, unpairState] = useUnpairAppSignMutation();
  const [errorCode, setErrorCode] = useState<string | null>(null);

  async function doPair() {
    setErrorCode(null);
    const res = await pair();
    if ('error' in res) setErrorCode((res.error as { code?: string })?.code ?? 'PAIR_FAILED');
  }

  return (
    <section className="dig-card" data-testid="appsign-pairing" aria-labelledby="appsign-title">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <h3 className="dig-subheading" id="appsign-title" style={{ margin: 0 }}>
          <FormattedMessage id="appSign.title" />
        </h3>
        {status.data && (
          <StatusPill tone={postureMeta(status.data).tone} testid="appsign-state">
            <FormattedMessage id={postureMeta(status.data).labelId} />
          </StatusPill>
        )}
      </div>

      <p className="dig-muted" style={{ marginBottom: 8 }}>
        <FormattedMessage id="appSign.intro" />
      </p>

      <FourState
        isLoading={status.isLoading}
        isError={status.isError}
        isEmpty={false}
        onRetry={() => void status.refetch()}
        errorId="appSign.error.status"
        testid="appsign-status"
      >
        {status.data && (
          <div>
            {status.data.connState !== 'connected' ? (
              <p className="dig-state" data-state="empty" role="status" data-testid="appsign-appdown" style={{ margin: 0 }}>
                <FormattedMessage id="appSign.appDown.desc" />
              </p>
            ) : status.data.paired ? (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <p className="dig-muted" data-testid="appsign-paired-desc" style={{ margin: 0, flex: 1 }}>
                  <FormattedMessage id="appSign.paired.desc" />
                </p>
                <button
                  type="button"
                  className="dig-btn"
                  data-testid="appsign-unpair"
                  disabled={unpairState.isLoading}
                  onClick={() => void unpair()}
                >
                  <FormattedMessage id="appSign.unpair" />
                </button>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <button
                  type="button"
                  className="dig-btn dig-btn--primary"
                  data-testid="appsign-pair"
                  disabled={pairState.isLoading}
                  onClick={() => void doPair()}
                >
                  <FormattedMessage id={pairState.isLoading ? 'appSign.pairing' : 'appSign.pair'} />
                </button>
                {errorCode && (
                  <p className="dig-state" data-state="error" role="alert" data-testid="appsign-error" style={{ margin: 0 }}>
                    <FormattedMessage id="appSign.pair.failed" values={{ code: errorCode }} />
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </FourState>
    </section>
  );
}
