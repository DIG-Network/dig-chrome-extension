import { FormattedMessage } from 'react-intl';

/**
 * One asset row in the wallet: a token badge, its name, the crypto amount, and a fiat line. The fiat
 * line renders one of three honest states: a real value (`≈ $12.34`), a muted loading placeholder
 * while prices load, or the "unavailable" variant (`≈ $—`) when no price exists — never a fabricated
 * value (§4.2). Amounts use the mono face + tabular numerals.
 */
export function AssetRow({
  ticker,
  name,
  amountLabel,
  fiatLabel,
  priceLoading = false,
  testid,
}: {
  ticker: string;
  name: string;
  amountLabel: string;
  /** A rendered fiat string (e.g. `≈ $12.34`), or null → loading / "unavailable". */
  fiatLabel: string | null;
  /** True while the price feed is loading and no value is known yet. */
  priceLoading?: boolean;
  testid?: string;
}) {
  const badge = ticker.replace(/^\$/, '').slice(0, 3).toUpperCase();
  return (
    <div className="dig-asset" data-testid={testid}>
      <span className="dig-asset-badge" aria-hidden="true">
        {badge}
      </span>
      <div className="dig-asset-main">
        <div className="dig-asset-name">{ticker}</div>
        <div className="dig-asset-sub">{name}</div>
      </div>
      <div>
        <div className="dig-asset-amt">{amountLabel}</div>
        <div className="dig-asset-fiat" data-testid={testid && `${testid}-fiat`}>
          {fiatLabel != null ? (
            <span>{fiatLabel}</span>
          ) : priceLoading ? (
            <span className="dig-fiat-loading" aria-hidden="true" data-testid={testid && `${testid}-fiat-loading`}>
              ≈ $…
            </span>
          ) : (
            <span title="No price feed for this asset">
              ≈ $—{' '}
              <span className="dig-sr-only">
                <FormattedMessage id="wallet.fiat.unavailable" />
              </span>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
