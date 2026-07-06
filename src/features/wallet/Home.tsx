import { useState } from 'react';
import { FormattedMessage } from 'react-intl';
import { FourState } from '@/components/FourState';
import { AssetRow } from '@/components/AssetRow';
import { StatusPill } from '@/components/StatusPill';
import { Sheet } from '@/components/Sheet';
import { ExternalLink } from '@/components/ExternalLink';
import { TIBETSWAP_URL } from '@/lib/links';
import { useGetBalancesQuery, useGetActivityQuery } from '@/features/wallet/walletApi';
import { pickHeroBalance, balancesAreEmpty } from '@/features/wallet/portfolio';
import { SendForm } from '@/features/wallet/SendForm';
import { ReceiveView } from '@/features/wallet/ReceiveView';
import { useIntl } from 'react-intl';

/**
 * The wallet Home (§2 first-fold): portfolio hero → Send/Receive/Trade action bar → assets list →
 * recent activity. Balances + activity come from RTK Query (four states each). Fiat is honestly
 * "unavailable" in Phase 0 (no price feed). Send/Receive open the shared Sheet; Trade switches the
 * segmented control.
 */
export function Home({ address, onGoTrade }: { address: string | undefined; onGoTrade: () => void }) {
  const intl = useIntl();
  const balances = useGetBalancesQuery();
  const activity = useGetActivityQuery();
  const [sheet, setSheet] = useState<'send' | 'receive' | null>(null);

  const hero = pickHeroBalance(balances.data);
  const rows = balances.data ?? [];
  const recent = (activity.data ?? []).slice(0, 3);

  return (
    <div data-testid="wallet-home">
      <section className="dig-card">
        <div className="dig-hero">
          <div className="dig-hero-label">
            <FormattedMessage id="wallet.portfolio.total" />
          </div>
          <div className="dig-hero-value" data-testid="portfolio-value">
            {hero.amountLabel} <span style={{ fontSize: '0.5em', color: 'var(--dig-text-faint)' }}>{hero.ticker}</span>
          </div>
          <div className="dig-muted">≈ $— · <FormattedMessage id="wallet.fiat.unavailable" /></div>
        </div>
        <div className="dig-actionbar" style={{ marginTop: 14 }}>
          <button type="button" className="dig-btn dig-btn--primary" data-testid="action-send" onClick={() => setSheet('send')}>
            <FormattedMessage id="wallet.action.send" />
          </button>
          <button type="button" className="dig-btn" data-testid="action-receive" onClick={() => setSheet('receive')}>
            <FormattedMessage id="wallet.action.receive" />
          </button>
          <button type="button" className="dig-btn" data-testid="action-trade" onClick={onGoTrade}>
            <FormattedMessage id="wallet.action.trade" />
          </button>
        </div>
      </section>

      <section className="dig-card" aria-labelledby="assets-title">
        <h3 className="dig-section-title" id="assets-title">
          <FormattedMessage id="wallet.assets.title" />
        </h3>
        <FourState
          isLoading={balances.isLoading}
          isError={balances.isError}
          isEmpty={!balances.isLoading && !balances.isError && balancesAreEmpty(balances.data)}
          onRetry={() => void balances.refetch()}
          loadingId="wallet.assets.loading"
          errorId="wallet.assets.error"
          emptyId="wallet.assets.empty"
          testid="wallet-assets"
        >
          <div data-testid="wallet-assets">
            {rows.map((r) => (
              <AssetRow
                key={r.descriptor.key + (r.descriptor.assetId ?? '')}
                ticker={r.descriptor.ticker}
                name={r.descriptor.name}
                amountLabel={r.label}
                fiatLabel={null}
                testid={`asset-${r.descriptor.key}`}
              />
            ))}
            <div style={{ marginTop: 12 }}>
              <ExternalLink href={TIBETSWAP_URL} testid="get-dig" closePopup>
                <FormattedMessage id="wallet.getdig" />
              </ExternalLink>
            </div>
          </div>
        </FourState>
      </section>

      <section className="dig-card" aria-labelledby="recent-title">
        <h3 className="dig-section-title" id="recent-title">
          <FormattedMessage id="wallet.recent.title" />
        </h3>
        <FourState
          isLoading={activity.isLoading}
          isError={activity.isError}
          isEmpty={!activity.isLoading && !activity.isError && recent.length === 0}
          onRetry={() => void activity.refetch()}
          loadingId="activity.loading"
          errorId="activity.error"
          emptyId="activity.empty"
          testid="recent-activity"
        >
          <div>
            {recent.map((it) => (
              <div className="dig-row" key={it.id} data-testid="recent-item">
                <span aria-hidden="true">{it.direction === 'out' ? '↑' : '↓'}</span>
                <div className="dig-row-main">
                  <div>
                    <FormattedMessage id={it.direction === 'out' ? 'activity.sent' : 'activity.received'} /> {it.amountLabel}{' '}
                    {it.asset === 'xch' ? 'XCH' : '$DIG'}
                  </div>
                  <div className="dig-muted">{it.timeLabel}</div>
                </div>
                <StatusPill tone={it.confirmed ? 'good' : 'warn'}>
                  <FormattedMessage id={it.confirmed ? 'activity.status.confirmed' : 'activity.status.pending'} />
                </StatusPill>
              </div>
            ))}
          </div>
        </FourState>
      </section>

      {sheet === 'send' && (
        <Sheet title={intl.formatMessage({ id: 'send.title' })} onClose={() => setSheet(null)} testid="send-sheet">
          <SendForm assets={rows} onDone={() => setSheet(null)} />
        </Sheet>
      )}
      {sheet === 'receive' && (
        <Sheet title={intl.formatMessage({ id: 'receive.title' })} onClose={() => setSheet(null)} testid="receive-sheet">
          <ReceiveView address={address} />
        </Sheet>
      )}
    </div>
  );
}
