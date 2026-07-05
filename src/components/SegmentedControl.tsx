import { FormattedMessage } from 'react-intl';

export interface SegmentOption<T extends string> {
  value: T;
  labelId: string;
}

/**
 * A segmented control rendered as an ARIA tablist (the wallet's Home/Activity/Trade switcher).
 * Each segment is a `role="tab"`; the caller renders the matching `role="tabpanel"`. Copy flows
 * through react-intl; segments carry stable `data-testid`s (`seg-<value>`).
 */
export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  idPrefix,
}: {
  value: T;
  options: ReadonlyArray<SegmentOption<T>>;
  onChange: (value: T) => void;
  ariaLabel: string;
  idPrefix: string;
}) {
  return (
    <div className="dig-seg" role="tablist" aria-label={ariaLabel}>
      {options.map((opt) => {
        const selected = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${opt.value}`}
            aria-selected={selected}
            aria-controls={`${idPrefix}-panel-${opt.value}`}
            tabIndex={selected ? 0 : -1}
            className="dig-seg-btn"
            data-testid={`seg-${opt.value}`}
            onClick={() => onChange(opt.value)}
          >
            <FormattedMessage id={opt.labelId} />
          </button>
        );
      })}
    </div>
  );
}
