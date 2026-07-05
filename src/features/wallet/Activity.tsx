import { FormattedMessage } from 'react-intl';
import { FourState } from '@/components/FourState';
import { StatusPill } from '@/components/StatusPill';
import { useGetActivityQuery } from '@/features/wallet/walletApi';

/**
 * The Activity ledger (§6 Activity): reverse-chronological, human-readable rows with a finality
 * status pill and a SpaceScan link per tx. Phase 0 formats Sage's `chia_getTransactions` via the
 * shared `activityViewModel`; Phase 2 replaces the source with the real coin-diff indexer. Four
 * states throughout.
 */
export function Activity() {
  const activity = useGetActivityQuery();
  const rows = activity.data ?? [];

  return (
    <section className="dig-card" data-testid="wallet-activity" aria-labelledby="activity-title">
      <h2 className="dig-heading" id="activity-title">
        <FormattedMessage id="activity.title" />
      </h2>
      <FourState
        isLoading={activity.isLoading}
        isError={activity.isError}
        isEmpty={!activity.isLoading && !activity.isError && rows.length === 0}
        onRetry={() => void activity.refetch()}
        loadingId="activity.loading"
        errorId="activity.error"
        emptyId="activity.empty"
        testid="activity"
      >
        <div>
          {rows.map((it) => (
            <div className="dig-row" key={it.id} data-testid="activity-item">
              <span aria-hidden="true">{it.direction === 'out' ? '↑' : '↓'}</span>
              <div className="dig-row-main">
                <div>
                  <FormattedMessage id={it.direction === 'out' ? 'activity.sent' : 'activity.received'} /> {it.amountLabel}{' '}
                  {it.asset === 'xch' ? 'XCH' : '$DIG'}
                </div>
                <div className="dig-muted">
                  {it.timeLabel}
                  {it.feeLabel ? ` · ${it.feeLabel}` : ''}
                  {it.spaceScanUrl && (
                    <>
                      {' · '}
                      <a className="dig-link" href={it.spaceScanUrl} target="_blank" rel="noreferrer noopener">
                        <FormattedMessage id="activity.viewOnSpaceScan" />
                      </a>
                    </>
                  )}
                </div>
              </div>
              <StatusPill tone={it.confirmed ? 'good' : 'warn'} testid={`activity-status-${it.id}`}>
                <FormattedMessage id={it.confirmed ? 'activity.status.confirmed' : 'activity.status.pending'} />
              </StatusPill>
            </div>
          ))}
        </div>
      </FourState>
    </section>
  );
}
