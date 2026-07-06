import { useIntl, FormattedMessage } from 'react-intl';
import type { PortfolioValue } from '@/features/wallet/portfolioValue';
import type { HeroBalance } from '@/features/wallet/portfolio';

/**
 * The portfolio hero: the total fiat value + its 24h change when prices are known, gracefully
 * falling back to the native crypto balance (with a muted status line) when they're not. The fiat
 * total NEVER blocks the wallet — a price outage just shows the native amount + "value unavailable".
 *
 * Four states are explicit (§6.4): success (fiat total + delta), loading (native amount + "loading
 * value"), error (native amount + "value unavailable" + retry), and — via the balances layer — empty.
 */
export function PortfolioHero({
  total,
  hero,
  pricesLoading,
  pricesError,
  onRetry,
}: {
  total: PortfolioValue;
  hero: HeroBalance;
  pricesLoading: boolean;
  pricesError: boolean;
  onRetry?: () => void;
}) {
  const intl = useIntl();

  if (total.totalUsd != null) {
    const fiat = intl.formatNumber(total.totalUsd, { style: 'currency', currency: 'USD' });
    return (
      <>
        <p className="dig-portfolio-value" data-testid="portfolio-value" style={{ margin: '2px 0 0' }}>
          {fiat}
        </p>
        {total.change24hPct != null && <Change24h pct={total.change24hPct} usd={total.change24hUsd ?? 0} />}
        <p className="dig-muted dig-portfolio-native" data-testid="portfolio-native" style={{ margin: '2px 0 0' }}>
          {hero.amountLabel} {hero.ticker}
        </p>
      </>
    );
  }

  // No fiat yet — show the honest native amount + a muted status line (never a blank hero).
  return (
    <>
      <p className="dig-portfolio-value" data-testid="portfolio-value" style={{ margin: '2px 0 0' }}>
        {hero.amountLabel} <span className="dig-muted">{hero.ticker}</span>
      </p>
      <p className="dig-muted" role="status" data-testid="portfolio-status" style={{ margin: '2px 0 0' }}>
        <FormattedMessage id={pricesLoading ? 'wallet.portfolio.loading' : 'wallet.portfolio.unavailable'} />
        {pricesError && onRetry && (
          <>
            {' '}
            <button type="button" className="dig-linkbtn" data-testid="portfolio-retry" onClick={onRetry}>
              <FormattedMessage id="state.retry" />
            </button>
          </>
        )}
      </p>
    </>
  );
}

/** The 24h change chip — green up / red down, an arrow glyph, and a screen-reader label. */
function Change24h({ pct, usd }: { pct: number; usd: number }) {
  const intl = useIntl();
  const up = pct >= 0;
  const pctLabel = intl.formatNumber(Math.abs(pct) / 100, {
    style: 'percent',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const usdLabel = intl.formatNumber(Math.abs(usd), { style: 'currency', currency: 'USD' });
  const direction = intl.formatMessage({ id: up ? 'wallet.portfolio.change.up' : 'wallet.portfolio.change.down' });
  const ariaLabel = intl.formatMessage({ id: 'wallet.portfolio.change24h.label' }, { direction, pct: pctLabel });
  return (
    <p
      className={`dig-change ${up ? 'dig-change--up' : 'dig-change--down'}`}
      data-testid="portfolio-change"
      data-direction={up ? 'up' : 'down'}
      aria-label={ariaLabel}
      style={{ margin: '4px 0 0' }}
    >
      <span aria-hidden="true">{up ? '▲' : '▼'} </span>
      <FormattedMessage id="wallet.portfolio.change24h" values={{ pct: pctLabel, amount: usdLabel }} />
    </p>
  );
}
