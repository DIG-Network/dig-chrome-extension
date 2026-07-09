import { useIntl } from 'react-intl';
import { useFiatPreference } from '@/features/wallet/useFiatPreference';
import { resolveFiatValue } from '@/features/wallet/fiatValue';

/**
 * Inline "≈ $12.34" fiat equivalent for an approval-window amount (#77 P2-1) — the SAME
 * `useFiatPreference`/`resolveFiatValue` idiom the wallet's own balances view (`PortfolioHero`)
 * uses, so the currency the user picked in Settings is honored here too. Renders NOTHING when the
 * USD value isn't known (no price yet, a price-feed outage, or an unpriced/unknown asset) — the
 * crypto amount shown alongside is always the authoritative figure being approved; a missing fiat
 * conversion never blocks or clutters the approval flow.
 */
export function FiatEquivalent({ usd }: { usd: number | null }) {
  const intl = useIntl();
  const { fiat, fx } = useFiatPreference(usd == null);
  if (usd == null) return null;
  const state = resolveFiatValue({ usd, fiat, fxRates: fx.data, fxLoading: fx.isLoading });
  if (state.kind === 'loading') return null;
  const label = intl.formatNumber(state.amount, { style: 'currency', currency: state.currency.toUpperCase() });
  return (
    <span className="dig-muted" data-testid="approval-fiat-equivalent" style={{ marginLeft: 6, fontSize: '0.85em' }}>
      ≈ {label}
    </span>
  );
}
