import { FormattedMessage } from 'react-intl';

/**
 * One asset row in the wallet: a token badge, its name, the crypto amount, and a fiat line. Phase 0
 * has no price feed, so fiat renders the honest "unavailable" variant (`≈ $—`) rather than a
 * fabricated value (§4.2). Amounts use the mono face + tabular numerals.
 */
export function AssetRow({
  ticker,
  name,
  amountLabel,
  fiatLabel,
  testid,
}: {
  ticker: string;
  name: string;
  amountLabel: string;
  /** A rendered fiat string, or null → the "fiat unavailable" line. */
  fiatLabel: string | null;
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
        <div className="dig-asset-fiat">
          {fiatLabel ?? (
            <span title="Phase 0: no price feed yet">
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
