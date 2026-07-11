import { FormattedMessage, useIntl } from 'react-intl';
import { useStorageValue } from '@/lib/useStorageValue';
import { ToggleSwitch } from '@/components/ToggleSwitch';
import { SegmentedControl } from '@/components/SegmentedControl';
import {
  AUTOTIP_CONFIG_KEY,
  DEFAULT_AUTOTIP_CONFIG,
  DEFAULT_AUTOTIP_AMOUNT_DIG,
  DEFAULT_AUTOTIP_MODE,
  isAutoTipMode,
  isValidTipAmount,
  type AutoTipConfig,
  type AutoTipMode,
} from '@/lib/autoTip';

const MODE_OPTIONS: ReadonlyArray<{ value: AutoTipMode; labelId: string }> = [
  { value: 'per-site-per-day', labelId: 'autotip.mode.perSitePerDay' },
  { value: 'per-day-period', labelId: 'autotip.mode.perDayPeriod' },
];

/**
 * Auto-tip preference (#379, child of #377) — the advanced-tier setting that authorizes UNATTENDED
 * $DIG tipping of DIG-content creators, with an amount + frequency policy. Fullscreen-only like the
 * other power-user settings (§145). $DIG North Star (§6.0): default OFF, one-click-off, and the honest
 * disclosure states plainly that it is a real recurring mainnet spend within the configured caps.
 *
 * This surface only PERSISTS the policy; the dig-node tipping subsystem (#377/#369) is what watches
 * for DIG loads and executes tips within these caps — it is not built yet, which the disclosure says.
 * The config blob persists to a single `chrome.storage.local` key (the `useStorageValue` idiom).
 */
export function AutoTipSetting() {
  const intl = useIntl();
  const [rawCfg, setCfg] = useStorageValue<AutoTipConfig>(AUTOTIP_CONFIG_KEY, DEFAULT_AUTOTIP_CONFIG);

  // Display the persisted values directly (the amount is shown RAW so typing never snaps back);
  // enabled/mode are coerced so a hand-edited blob can't desync the controls.
  const raw = (rawCfg && typeof rawCfg === 'object' ? rawCfg : {}) as Partial<AutoTipConfig>;
  const enabled = raw.enabled === true;
  const mode: AutoTipMode = isAutoTipMode(raw.mode) ? raw.mode : DEFAULT_AUTOTIP_MODE;
  const amountDig = typeof raw.amountDig === 'string' ? raw.amountDig : DEFAULT_AUTOTIP_AMOUNT_DIG;
  const perSiteOverrides = raw.perSiteOverrides && typeof raw.perSiteOverrides === 'object' ? raw.perSiteOverrides : {};
  const current: AutoTipConfig = { enabled, amountDig, mode, perSiteOverrides };
  const update = (patch: Partial<AutoTipConfig>) => setCfg({ ...current, ...patch });

  const amountValid = isValidTipAmount(amountDig);

  return (
    <section className="dig-card" data-testid="auto-tip-setting" aria-labelledby="auto-tip-title">
      <div className="dig-toggle-row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
        <span id="auto-tip-title" style={{ fontWeight: 500 }}>
          <FormattedMessage id="autotip.title" />
        </span>
        <ToggleSwitch
          checked={enabled}
          onChange={(v) => update({ enabled: v })}
          label={intl.formatMessage({ id: 'autotip.enable.label' })}
          testid="auto-tip-toggle"
        />
      </div>

      <p className="dig-muted" style={{ marginTop: 0 }}>
        <FormattedMessage id="autotip.disclosure" />
      </p>

      <label className="dig-field" style={{ marginBottom: 8 }}>
        <span>
          <FormattedMessage id="autotip.amount.label" />
        </span>
        <input
          className="dig-input"
          data-testid="auto-tip-amount"
          type="text"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          value={amountDig}
          aria-invalid={!amountValid || undefined}
          onChange={(e) => update({ amountDig: e.target.value })}
        />
      </label>
      {!amountValid && (
        <p className="dig-error-text" role="alert" data-testid="auto-tip-amount-error" style={{ margin: '0 0 8px' }}>
          <FormattedMessage id="autotip.amount.invalid" />
        </p>
      )}

      <span className="dig-muted" id="auto-tip-mode-label" style={{ display: 'block', marginBottom: 4 }}>
        <FormattedMessage id="autotip.mode.label" />
      </span>
      <SegmentedControl<AutoTipMode>
        value={mode}
        options={MODE_OPTIONS}
        onChange={(m) => update({ mode: m })}
        ariaLabel={intl.formatMessage({ id: 'autotip.mode.label' })}
        idPrefix="autotip-mode"
      />
    </section>
  );
}
