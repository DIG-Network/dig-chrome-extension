import { useEffect, useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { formatBaseUnits } from '@/lib/wallet-view';
import { useGetFeeEstimateQuery } from '@/features/wallet/custody/feeApi';
import { FALLBACK_FEE_MOJOS, type FeeSpeed } from '@/features/wallet/custody/feeEstimate';

const XCH_DECIMALS = 12;
const SPEEDS: FeeSpeed[] = ['fast', 'normal', 'slow'];

/**
 * The Send flow's network-fee control (#206/#110) — a bias-to-estimate fee picker.
 *
 * By DEFAULT the fee is the live coinset.org estimate (§feeApi), shown as a READ-ONLY line item
 * ("Network fee: X XCH · estimated") with three speed presets (fast/normal/slow, #110) and a small
 * "Override" button. Accepting the estimate is one tap; overriding is deliberate and secondary
 * (#206) — clicking Override turns the line into an editable numeric input, and "Use estimate"
 * reverts to the selected preset. All four async states are handled (§6.4): a loading indicator while
 * estimating (never "unavailable" mid-fetch, #158), and on failure an honest note + a sane default
 * fee ({@link FALLBACK_FEE_MOJOS}) + the manual input so a send is never blocked.
 *
 * The fee is owned by the parent (`SendPanel`) as an XCH decimal string; this component reads it and
 * pushes changes up via `onFee` (the selected preset while estimating, or the typed value while
 * overriding). `onFee` MUST be stable (e.g. a `useState` setter) — it is a dependency of the
 * estimate-sync effect.
 */
export function FeeField({ fee, onFee }: { fee: string; onFee: (xchValue: string) => void }) {
  const intl = useIntl();
  const { data, isLoading, isError, refetch } = useGetFeeEstimateQuery();
  const [speed, setSpeed] = useState<FeeSpeed>('normal');
  const [override, setOverride] = useState(false);

  const presets = data?.presets;
  const estimateXch = presets ? formatBaseUnits(presets[speed], XCH_DECIMALS) : null;

  // Bias-to-estimate: while accepting the estimate, keep the parent fee synced to the selected
  // preset. Skipped while overriding (the user owns the value) — deps exclude `fee` so this never
  // loops on its own write.
  useEffect(() => {
    if (!override && estimateXch != null) onFee(estimateXch);
  }, [override, estimateXch, onFee]);

  // Honest failure fallback: drop to a sane default fee and open the manual input so the send is
  // never blocked by an unreachable estimate endpoint.
  useEffect(() => {
    if (isError) {
      setOverride(true);
      onFee(formatBaseUnits(FALLBACK_FEE_MOJOS, XCH_DECIMALS));
    }
  }, [isError, onFee]);

  if (isLoading) {
    return (
      <div className="dig-field">
        <span>
          <FormattedMessage id="fee.label" />
        </span>
        <div className="dig-state" data-state="loading" role="status" aria-live="polite" data-testid="fee-estimating">
          <FormattedMessage id="fee.estimating" />
        </div>
      </div>
    );
  }

  const overrideInput = (
    <input
      data-testid="fee-override-input"
      className="dig-input"
      value={fee}
      onChange={(e) => onFee(e.target.value)}
      inputMode="decimal"
      autoComplete="off"
      aria-label={intl.formatMessage({ id: 'fee.override.aria' })}
    />
  );

  if (isError) {
    return (
      <div className="dig-field">
        <span>
          <FormattedMessage id="fee.label" /> ({intl.formatMessage({ id: 'fee.unit' })})
        </span>
        <p className="dig-muted" data-testid="fee-error" role="status" style={{ margin: '2px 0 6px', fontSize: '0.85em' }}>
          <FormattedMessage id="fee.unavailable" />{' '}
          <button type="button" className="dig-link" data-testid="fee-retry" onClick={() => void refetch()}>
            <FormattedMessage id="state.retry" />
          </button>
        </p>
        {overrideInput}
      </div>
    );
  }

  // Success — the estimate is available.
  return (
    <div className="dig-field" data-testid="fee-field">
      <span>
        <FormattedMessage id="fee.label" />
      </span>

      {override ? (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {overrideInput}
          <button type="button" className="dig-link" data-testid="fee-use-estimate" onClick={() => setOverride(false)}>
            <FormattedMessage id="fee.useEstimate" />
          </button>
        </div>
      ) : (
        <div data-testid="fee-line">
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
            <span data-testid="fee-line-amount">
              <span className="dig-mono">{estimateXch}</span> {intl.formatMessage({ id: 'fee.unit' })}{' '}
              <span className="dig-muted" style={{ fontSize: '0.85em' }}>
                · <FormattedMessage id="fee.estimatedTag" />
              </span>
            </span>
            <button type="button" className="dig-link" data-testid="fee-override-toggle" onClick={() => setOverride(true)}>
              <FormattedMessage id="fee.override" />
            </button>
          </div>
          <div
            className="dig-seg"
            role="listbox"
            aria-label={intl.formatMessage({ id: 'fee.presets.aria' })}
            style={{ marginTop: 8, width: '100%' }}
          >
            {SPEEDS.map((s) => (
              <button
                key={s}
                type="button"
                role="option"
                aria-selected={speed === s}
                className="dig-seg-btn"
                data-testid={`fee-preset-${s}`}
                onClick={() => setSpeed(s)}
                style={{ flex: 1 }}
              >
                <FormattedMessage id={`fee.preset.${s}`} />
                {presets && (
                  <span className="dig-muted" style={{ display: 'block', fontSize: '0.72em', fontWeight: 400 }}>
                    {formatBaseUnits(presets[s], XCH_DECIMALS)}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
