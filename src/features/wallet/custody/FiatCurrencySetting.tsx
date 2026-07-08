import { useId } from 'react';
import { useIntl } from 'react-intl';
import { SUPPORTED_FIAT_CURRENCIES, type FiatCode } from '@/features/wallet/fiatCurrency';

/**
 * The fiat-currency display picker (#112) — a compact `<select>` beside the portfolio total, same
 * idiom as `AppFooter`'s language selector. Currency codes + symbols are rendered as-is (like the
 * 14-locale picker's own per-locale labels) rather than through per-locale translated currency
 * NAMES — a currency code (`EUR`) + symbol (`€`) reads universally, so this stays a single
 * maintained list instead of 13 currencies × 14 locales of translated names.
 */
export function FiatCurrencySetting({ value, onChange }: { value: FiatCode; onChange: (code: FiatCode) => void }) {
  const intl = useIntl();
  const id = useId();
  const label = intl.formatMessage({ id: 'wallet.currency.label' });
  return (
    <label className="dig-currency-setting" htmlFor={id} title={intl.formatMessage({ id: 'wallet.currency.hint' })}>
      <span className="dig-sr-only">{label}</span>
      <select
        id={id}
        data-testid="fiat-currency-select"
        className="dig-select"
        style={{ width: 'auto', padding: '4px 8px', fontSize: 11 }}
        value={value}
        aria-label={label}
        onChange={(e) => onChange(e.target.value as FiatCode)}
      >
        {SUPPORTED_FIAT_CURRENCIES.map((c) => (
          <option key={c.code} value={c.code}>
            {c.code.toUpperCase()} {c.symbol}
          </option>
        ))}
      </select>
    </label>
  );
}
