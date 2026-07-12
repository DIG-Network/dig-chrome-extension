import { useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { FourState } from '@/components/FourState';
import { StatusPill } from '@/components/StatusPill';
import { ExternalLink } from '@/components/ExternalLink';
import { spaceScanCoinUrl } from '@/lib/links';
import { useGetTipLedgerQuery } from '@/features/tipping/tippingApi';
import {
  TIP_TIMEFRAMES,
  filterLedgerByTimeframe,
  summarizeLedger,
  baseUnitsToDigString,
  tipEntryMillis,
  type TipTimeframe,
  type TipLedgerEntry,
} from '@/lib/tipping';

const TIMEFRAME_OPTIONS: ReadonlyArray<{ value: TipTimeframe; labelId: string }> = TIP_TIMEFRAMES.map((v) => ({
  value: v,
  labelId: `tip.tab.timeframe.${v}`,
}));

const STATUS_TONE: Record<TipLedgerEntry['status'], 'good' | 'neutral' | 'bad'> = {
  confirmed: 'good',
  pending: 'neutral',
  failed: 'bad',
};

/** A short, mono-friendly id (first 8 / last 6) for a store id or puzzle hash. */
function shortId(id: string): string {
  const s = id.replace(/^0x/i, '');
  return s.length > 18 ? `${s.slice(0, 8)}…${s.slice(-6)}` : s;
}

/** One ledger row: who / how much / when / status / tx link. */
function TipRow({ entry }: { entry: TipLedgerEntry }) {
  const intl = useIntl();
  const who = entry.store_id ? shortId(entry.store_id) : entry.recipient_ph ? shortId(entry.recipient_ph) : '—';
  const txUrl = spaceScanCoinUrl(entry.txid ?? null);
  return (
    <tr data-testid="tip-row" data-tip-id={entry.id}>
      <td>
        <span title={entry.store_id || entry.recipient_ph} style={{ fontFamily: 'monospace', fontSize: 12 }}>
          {who}
        </span>
        <span className="dig-muted" style={{ marginLeft: 6, fontSize: 11 }}>
          <FormattedMessage id={entry.kind === 'dev' ? 'tip.tab.kind.dev' : 'tip.tab.kind.creator'} />
        </span>
      </td>
      <td data-testid="tip-amount">{baseUnitsToDigString(entry.dig_amount)} $DIG</td>
      <td className="dig-muted" style={{ fontSize: 12 }}>
        {intl.formatDate(tipEntryMillis(entry), { dateStyle: 'medium', timeStyle: 'short' })}
      </td>
      <td>
        <StatusPill tone={STATUS_TONE[entry.status]} testid="tip-status">
          <FormattedMessage id={`tip.tab.status.${entry.status}`} />
        </StatusPill>
      </td>
      <td>
        {txUrl ? (
          <ExternalLink href={txUrl} className="dig-link" testid="tip-tx-link">
            <FormattedMessage id="tip.tab.history.viewTx" />
          </ExternalLink>
        ) : (
          <span className="dig-muted" style={{ fontSize: 12 }}>
            —
          </span>
        )}
      </td>
    </tr>
  );
}

/**
 * Tip history (#380) — the tip ledger from the node (`tip.get_ledger`), grouped by a timeframe filter
 * (today / 7d / 30d / all). Shows who was tipped (store/owner, creator|dev), how much $DIG, when, the
 * status, and a SpaceScan tx link. Four explicit states; the empty state is INFORMATIVE, not broken —
 * the ledger stays empty until the node's wallet can actually send tips (#428).
 */
export function TipHistorySection({ nodeOnline }: { nodeOnline: boolean }) {
  const intl = useIntl();
  const [timeframe, setTimeframe] = useState<TipTimeframe>('all');
  const ledger = useGetTipLedgerQuery(undefined, { skip: !nodeOnline });

  const all = ledger.data ?? [];
  const shown = filterLedgerByTimeframe(all, timeframe, Date.now());
  const summary = summarizeLedger(shown);

  return (
    <section className="dig-card" data-testid="tip-history" aria-labelledby="tip-history-title">
      <h3 className="dig-subheading" id="tip-history-title" style={{ marginTop: 0 }}>
        <FormattedMessage id="tip.tab.history.title" />
      </h3>

      {!nodeOnline ? (
        <p className="dig-muted" data-testid="tip-history-nodedown" style={{ margin: 0 }}>
          <FormattedMessage id="tip.tab.nodeDown" />
        </p>
      ) : (
        <>
          <div className="dig-seg-wrap" style={{ marginBottom: 12 }}>
            <div className="dig-seg" role="tablist" aria-label={intl.formatMessage({ id: 'tip.tab.timeframe.label' })}>
              {TIMEFRAME_OPTIONS.map((opt) => {
                const selected = opt.value === timeframe;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    tabIndex={selected ? 0 : -1}
                    className="dig-seg-btn"
                    data-testid={`tip-timeframe-${opt.value}`}
                    onClick={() => setTimeframe(opt.value)}
                  >
                    <FormattedMessage id={opt.labelId} />
                  </button>
                );
              })}
            </div>
          </div>

          <FourState
            isLoading={ledger.isLoading}
            isError={ledger.isError}
            isEmpty={shown.length === 0}
            onRetry={() => void ledger.refetch()}
            errorId="tip.tab.history.error"
            emptyId="tip.tab.history.empty"
            testid="tip-history"
          >
            <p className="dig-muted" data-testid="tip-history-summary" style={{ margin: '0 0 8px' }}>
              <FormattedMessage
                id="tip.tab.history.summary"
                values={{ count: summary.count, total: baseUnitsToDigString(summary.totalBaseUnits) }}
              />
            </p>
            <div style={{ overflowX: 'auto' }}>
              <table className="dig-table" data-testid="tip-history-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left' }}>
                      <FormattedMessage id="tip.tab.history.col.who" />
                    </th>
                    <th style={{ textAlign: 'left' }}>
                      <FormattedMessage id="tip.tab.history.col.amount" />
                    </th>
                    <th style={{ textAlign: 'left' }}>
                      <FormattedMessage id="tip.tab.history.col.when" />
                    </th>
                    <th style={{ textAlign: 'left' }}>
                      <FormattedMessage id="tip.tab.history.col.status" />
                    </th>
                    <th style={{ textAlign: 'left' }}>
                      <FormattedMessage id="tip.tab.history.col.tx" />
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((e) => (
                    <TipRow key={e.id} entry={e} />
                  ))}
                </tbody>
              </table>
            </div>
          </FourState>
        </>
      )}
    </section>
  );
}
