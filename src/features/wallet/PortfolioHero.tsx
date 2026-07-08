import { useIntl, FormattedMessage } from 'react-intl';
import type { PortfolioValue } from '@/features/wallet/portfolioValue';
import type { HeroBalance } from '@/features/wallet/portfolio';
import { resolveFiatValue } from '@/features/wallet/fiatValue';
import type { FiatCode } from '@/features/wallet/fiatCurrency';
import type { FxRateMap } from '@/features/wallet/fxRates';

/**
 * The portfolio hero: the total fiat value + its 24h change when prices are known, gracefully
 * falling back to the native crypto balance (with a muted status line) when they're not. The fiat
 * total NEVER blocks the wallet — a price outage just shows the native amount + "value unavailable".
 *
 * Four states are explicit (§6.4): success (fiat total + delta), loading (native amount + "loading
 * value"), error (native amount + "value unavailable" + retry), and — via the balances layer — empty.
 *
 * The `fiat`/`fxRates`/`fxLoading` props (#112) resolve the user's chosen display currency via
 * `resolveFiatValue`: `fiat === 'usd'` needs no rate lookup; a non-USD currency converts once its
 * rate is known, shows its OWN loading skeleton while the rate is still in flight (never the
 * "unavailable" text mid-fetch, #158), and gracefully degrades back to USD if the rate genuinely
 * couldn't be obtained — the total is never blocked by a currency-conversion hiccup.
 */
export function PortfolioHero({
  total,
  hero,
  pricesLoading,
  pricesError,
  onRetry,
  fiat,
  fxRates,
  fxLoading,
}: {
  total: PortfolioValue;
  hero: HeroBalance;
  pricesLoading: boolean;
  pricesError: boolean;
  onRetry?: () => void;
  /** The user's chosen display currency (#112). */
  fiat: FiatCode;
  fxRates: FxRateMap | undefined;
  /** True while the fiat exchange-rate fetch is in flight (only meaningful when `fiat !== 'usd'`). */
  fxLoading: boolean;
}) {
  const intl = useIntl();

  if (total.totalUsd != null) {
    const totalState = resolveFiatValue({ usd: total.totalUsd, fiat, fxRates, fxLoading });
    if (totalState.kind === 'loading') {
      return (
        <>
          <p className="dig-portfolio-value" data-testid="portfolio-value" style={{ margin: '2px 0 0' }}>
            <span className="dig-skeleton dig-balance-skeleton--lg" data-testid="portfolio-value-loading" aria-hidden="true" />
            <span className="dig-sr-only"><FormattedMessage id="state.loading" /></span>
          </p>
          <p className="dig-muted dig-portfolio-native" data-testid="portfolio-native" style={{ margin: '2px 0 0' }}>
            {hero.amountLabel} {hero.ticker}
          </p>
        </>
      );
    }
    const fiatLabel = intl.formatNumber(totalState.amount, { style: 'currency', currency: totalState.currency.toUpperCase() });
    // The 24h change amount converts with the SAME resolved currency (falls back alongside the
    // total — a currency-conversion hiccup on the total means the change amount degrades too).
    const changeState =
      total.change24hUsd != null ? resolveFiatValue({ usd: total.change24hUsd, fiat: totalState.currency, fxRates, fxLoading: false }) : null;
    return (
      <>
        <p className="dig-portfolio-value" data-testid="portfolio-value" style={{ margin: '2px 0 0' }}>
          {fiatLabel}
        </p>
        {total.change24hPct != null && changeState?.kind === 'value' && (
          <Change24h pct={total.change24hPct} amount={changeState.amount} currency={changeState.currency} />
        )}
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
function Change24h({ pct, amount, currency }: { pct: number; amount: number; currency: FiatCode }) {
  const intl = useIntl();
  const up = pct >= 0;
  const pctLabel = intl.formatNumber(Math.abs(pct) / 100, {
    style: 'percent',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const amountLabel = intl.formatNumber(Math.abs(amount), { style: 'currency', currency: currency.toUpperCase() });
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
      <FormattedMessage id="wallet.portfolio.change24h" values={{ pct: pctLabel, amount: amountLabel }} />
    </p>
  );
}
