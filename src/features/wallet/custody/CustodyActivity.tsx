import { useState } from 'react';
import { FormattedMessage } from 'react-intl';
import { FourState } from '@/components/FourState';
import { ExternalLink } from '@/components/ExternalLink';
import { useStorageValue } from '@/lib/useStorageValue';
import { useGetCustodyActivityQuery } from '@/features/wallet/custodyApi';
import { activityRows, type ActivityRow } from '@/features/wallet/custody/activityRows';

const ICON: Record<ActivityRow['kind'], string> = { sent: '↑', received: '⇩', trade: '⇄' };
const SENTENCE_ID: Record<ActivityRow['kind'], string> = {
  sent: 'activity.line.sent',
  received: 'activity.line.received',
  trade: 'activity.line.traded',
};

/**
 * The self-custody Activity ledger (§4.3) — human-sentence rows from the offscreen indexer, four
 * states (loading skeleton / error+retry / empty / success), each row expandable to a receipt
 * (counterparty, height, coin id, SpaceScan). Read-only; cached-first via the SW cache.
 */
export function CustodyActivity() {
  const [watchedCats] = useStorageValue<unknown>('wallet.watchedCats', []);
  const activity = useGetCustodyActivityQuery();
  const rows = activityRows(activity.data?.events ?? [], watchedCats);
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <div data-testid="custody-activity">
      <h2 className="dig-heading">
        <FormattedMessage id="activity.title" />
      </h2>
      <FourState
        isLoading={activity.isLoading}
        isError={activity.isError}
        isEmpty={!activity.isLoading && !activity.isError && rows.length === 0}
        onRetry={() => void activity.refetch()}
        testid="custody-activity-list"
        loadingId="activity.loading"
        errorId="activity.error"
        emptyId="activity.empty"
      >
        <ul className="dig-activity" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {rows.map((row) => (
            <li key={row.id} className="dig-activity-row" data-testid={`activity-${row.id}`}>
              <button
                type="button"
                className="dig-activity-line"
                data-testid={`activity-line-${row.id}`}
                aria-expanded={openId === row.id}
                onClick={() => setOpenId(openId === row.id ? null : row.id)}
                style={{ display: 'flex', width: '100%', gap: 8, textAlign: 'left', background: 'none', border: 0, padding: '8px 0', cursor: 'pointer' }}
              >
                <span aria-hidden="true">{ICON[row.kind]}</span>
                <span style={{ flex: 1 }}>
                  <FormattedMessage id={SENTENCE_ID[row.kind]} values={{ amount: row.amountLabel, ticker: row.ticker }} />
                  {row.counterparty && (
                    <>
                      {' '}
                      <FormattedMessage id="activity.line.to" values={{ who: row.counterparty }} />
                    </>
                  )}
                </span>
              </button>
              {openId === row.id && (
                <dl className="dig-summary" data-testid={`activity-receipt-${row.id}`}>
                  {row.counterparty && (
                    <>
                      <dt><FormattedMessage id="activity.receipt.to" /></dt>
                      <dd className="dig-mono">{row.counterparty}</dd>
                    </>
                  )}
                  <dt><FormattedMessage id="activity.receipt.height" /></dt>
                  <dd>{row.height}</dd>
                  <dt><FormattedMessage id="activity.receipt.coin" /></dt>
                  <dd className="dig-mono" style={{ wordBreak: 'break-all' }}>{row.coinId}</dd>
                  {row.spaceScanUrl && (
                    <dd>
                      <ExternalLink href={row.spaceScanUrl} testid={`activity-spacescan-${row.id}`}>
                        <FormattedMessage id="activity.viewOnSpaceScan" />
                      </ExternalLink>
                    </dd>
                  )}
                </dl>
              )}
            </li>
          ))}
        </ul>
      </FourState>
    </div>
  );
}
