import { useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { FourState } from '@/components/FourState';
import { ExternalLink } from '@/components/ExternalLink';
import { useGetCustodyActivityQuery } from '@/features/wallet/custodyApi';
import { useGetCatRegistryQuery } from '@/features/wallet/catMetadataApi';
import { activityRows, type ActivityRow } from '@/features/wallet/custody/activityRows';

/** Decorative glyph per activity kind — covers all nine schema kinds (#154/#171) even though only
 * sent/received/mint/did/trade/burn are currently EMITTED (see `lib/activity-log.ts`'s `ActivityKind`
 * doc); offer/clawback/melt render correctly the moment a future change starts logging them. */
const ICON: Record<ActivityRow['kind'], string> = {
  sent: '↑',
  received: '⇩',
  trade: '⇄',
  mint: '✦',
  did: '◈',
  offer: '⇗',
  clawback: '↩',
  melt: '⟲',
  burn: '🔥',
};
/** Message id per kind — sent/received/trade/mint/clawback/melt/burn interpolate `{amount}`/
 * `{ticker}`; did/offer are amount-agnostic (a DID/offer spend's "amount" is a non-meaningful mojo
 * dust value). */
const SENTENCE_ID: Record<ActivityRow['kind'], string> = {
  sent: 'activity.line.sent',
  received: 'activity.line.received',
  trade: 'activity.line.traded',
  mint: 'activity.line.mint',
  did: 'activity.line.did',
  offer: 'activity.line.offer',
  clawback: 'activity.line.clawback',
  melt: 'activity.line.melt',
  burn: 'activity.line.burn',
};

/**
 * The self-custody Activity ledger (§154) — human-sentence rows from the LOCAL activity log (the
 * extension's own record of what it did, plus balance-delta receives — NOT an on-chain
 * reconstruction), four states (loading skeleton / error+retry / empty / success), each row
 * expandable to a full transaction-detail receipt (#113: amount/asset, counterparty + its
 * SpaceScan address link, fee/memo when recorded, status, timestamp, coin id, the per-spend
 * SpaceScan link, and — for a CAT-class asset — its own SpaceScan token-page link, #114). Read-only;
 * loads instantly from `chrome.storage.local` (see `src/background/index.ts`'s `getActivity`).
 */
export function CustodyActivity() {
  const intl = useIntl();
  const activity = useGetCustodyActivityQuery();
  // Same dexie registry the Assets list resolves against (#151) — a held CAT's real ticker shows in
  // the ledger instead of the generic 'CAT' fallback.
  const registry = useGetCatRegistryQuery();
  const rows = activityRows(activity.data?.events ?? [], registry.data);
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
                  <dt><FormattedMessage id="activity.receipt.amount" /></dt>
                  <dd className="dig-mono" data-testid={`activity-amount-${row.id}`}>
                    {row.amountLabel} {row.ticker}
                  </dd>
                  {row.counterparty && (
                    <>
                      <dt><FormattedMessage id="activity.receipt.to" /></dt>
                      <dd className="dig-mono">
                        {row.counterparty}
                        {row.counterpartyUrl && (
                          <>
                            {' '}
                            <ExternalLink href={row.counterpartyUrl} testid={`activity-address-link-${row.id}`}>
                              <FormattedMessage id="activity.viewAddressOnSpaceScan" />
                            </ExternalLink>
                          </>
                        )}
                      </dd>
                    </>
                  )}
                  <dt><FormattedMessage id="activity.receipt.status" /></dt>
                  <dd data-testid={`activity-status-${row.id}`}>
                    <FormattedMessage id={row.status === 'confirmed' ? 'activity.status.confirmed' : 'activity.status.pending'} />
                  </dd>
                  <dt><FormattedMessage id="activity.receipt.timestamp" /></dt>
                  <dd data-testid={`activity-timestamp-${row.id}`}>
                    {intl.formatDate(row.timestamp, { dateStyle: 'medium', timeStyle: 'short' })}
                  </dd>
                  {row.feeLabel != null && (
                    <>
                      <dt><FormattedMessage id="activity.receipt.fee" /></dt>
                      <dd className="dig-mono" data-testid={`activity-fee-${row.id}`}>{row.feeLabel} XCH</dd>
                    </>
                  )}
                  {row.memo != null && (
                    <>
                      <dt><FormattedMessage id="activity.receipt.memo" /></dt>
                      <dd data-testid={`activity-memo-${row.id}`}>{row.memo}</dd>
                    </>
                  )}
                  {row.coinId && (
                    <>
                      <dt><FormattedMessage id="activity.receipt.coin" /></dt>
                      <dd className="dig-mono" style={{ wordBreak: 'break-all' }}>{row.coinId}</dd>
                    </>
                  )}
                  {row.spaceScanUrl && (
                    <dd>
                      <ExternalLink href={row.spaceScanUrl} testid={`activity-spacescan-${row.id}`}>
                        <FormattedMessage id="activity.viewOnSpaceScan" />
                      </ExternalLink>
                    </dd>
                  )}
                  {row.tokenUrl && (
                    <dd>
                      <ExternalLink href={row.tokenUrl} testid={`activity-token-link-${row.id}`}>
                        <FormattedMessage id="activity.viewTokenOnSpaceScan" />
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
