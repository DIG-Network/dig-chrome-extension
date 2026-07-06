import { useState } from 'react';
import { FormattedMessage } from 'react-intl';

/**
 * One asset row in the wallet: a token badge, its name, the crypto amount, and a fiat line. The fiat
 * line renders one of three honest states: a real value (`≈ $12.34`), a muted loading placeholder
 * while prices load, or the "unavailable" variant (`≈ $—`) when no price exists — never a fabricated
 * value (§4.2). Amounts use the mono face + tabular numerals.
 *
 * The badge shows the token's registry icon when available (auto-discovered CATs, #87); if the icon
 * is absent or fails to load it falls back to a text monogram, so a row NEVER shows a broken image.
 */
export function AssetRow({
  ticker,
  name,
  amountLabel,
  fiatLabel,
  iconUrl,
  priceLoading = false,
  testid,
}: {
  ticker: string;
  name: string;
  amountLabel: string;
  /** A rendered fiat string (e.g. `≈ $12.34`), or null → loading / "unavailable". */
  fiatLabel: string | null;
  /** Token icon URL (CAT registry); null/undefined or a load failure → the monogram badge. */
  iconUrl?: string | null;
  /** True while the price feed is loading and no value is known yet. */
  priceLoading?: boolean;
  testid?: string;
}) {
  return (
    <div className="dig-asset" data-testid={testid}>
      <AssetBadge ticker={ticker} iconUrl={iconUrl} testid={testid} />
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

/** The token badge: the registry icon if it loads, else a text monogram from the ticker. Decorative. */
function AssetBadge({ ticker, iconUrl, testid }: { ticker: string; iconUrl?: string | null; testid?: string }) {
  const [failed, setFailed] = useState(false);
  const monogram = ticker.replace(/^\$/, '').slice(0, 3).toUpperCase();
  if (iconUrl && !failed) {
    return (
      <img
        className="dig-asset-icon"
        src={iconUrl}
        alt=""
        aria-hidden="true"
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
        data-testid={testid && `${testid}-icon`}
      />
    );
  }
  return (
    <span className="dig-asset-badge" aria-hidden="true">
      {monogram}
    </span>
  );
}
