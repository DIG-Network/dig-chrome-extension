import { useId } from 'react';
import { useIntl } from 'react-intl';
import type { AssetSuggestion } from '@/features/wallet/custody/assetFilter';

/**
 * The live filter input above the Assets/CAT list (#167): a compact, single-line search box with
 * native autocomplete suggestions (a `<datalist>` — keyboard + screen-reader accessible with no
 * bespoke combobox widget) and a clear affordance once there's text to clear. Controlled + fully
 * presentational: the parent owns `value`/filtering/ordering, this just renders the control.
 */
export function AssetFilterField({
  value,
  onChange,
  suggestions,
  testid,
}: {
  value: string;
  onChange: (value: string) => void;
  suggestions: AssetSuggestion[];
  testid?: string;
}) {
  const intl = useIntl();
  const listId = useId();
  const label = intl.formatMessage({ id: 'wallet.assets.filter.label' });

  return (
    <div className="dig-asset-filter" data-testid={testid}>
      <input
        className="dig-input"
        type="search"
        role="searchbox"
        list={listId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={intl.formatMessage({ id: 'wallet.assets.filter.placeholder' })}
        aria-label={label}
        autoComplete="off"
        spellCheck={false}
        data-testid={testid && `${testid}-input`}
      />
      <datalist id={listId}>
        {suggestions.map((s) => (
          <option key={s.ticker} value={s.ticker}>
            {s.name}
          </option>
        ))}
      </datalist>
      {value && (
        <button
          type="button"
          className="dig-asset-filter-clear"
          onClick={() => onChange('')}
          aria-label={intl.formatMessage({ id: 'wallet.assets.filter.clear' })}
          data-testid={testid && `${testid}-clear`}
        >
          ×
        </button>
      )}
    </div>
  );
}
