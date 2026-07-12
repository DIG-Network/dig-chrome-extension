import { useEffect, useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { FourState } from '@/components/FourState';
import { ToggleSwitch } from '@/components/ToggleSwitch';
import { SegmentedControl } from '@/components/SegmentedControl';
import { PairingSection } from '@/features/control/PairingSection';
import { useGetTipConfigQuery, useSetTipConfigMutation } from '@/features/tipping/tippingApi';
import {
  tipConfigToForm,
  tipFormToConfig,
  isTipFormValid,
  isAmountField,
  digStringToBaseUnits,
  baseUnitsToDigString,
  TIP_MODES,
  type TipMode,
  type TipPolicyForm,
  type TipConfigForm,
} from '@/lib/tipping';

const MODE_OPTIONS: ReadonlyArray<{ value: TipMode; labelId: string }> = TIP_MODES.map((v) => ({
  value: v,
  labelId: v === 'daily-budget' ? 'tip.tab.mode.dailyBudget' : 'tip.tab.mode.perSitePerDay',
}));

/** Editable controls for ONE auto-tip policy (creator or dev). `showOverrides` adds the per-store editor. */
function PolicyEditor({
  titleId,
  captionId,
  policy,
  onChange,
  idPrefix,
  showOverrides,
}: {
  titleId: string;
  captionId: string;
  policy: TipPolicyForm;
  onChange: (patch: Partial<TipPolicyForm>) => void;
  idPrefix: string;
  showOverrides: boolean;
}) {
  const intl = useIntl();
  const [ovStore, setOvStore] = useState('');
  const [ovAmount, setOvAmount] = useState('');
  const amountValid = isAmountField(policy.amount);
  const capValid = isAmountField(policy.perSiteCap);
  const overrides = Object.entries(policy.perSiteOverrides);

  const addOverride = () => {
    const base = digStringToBaseUnits(ovAmount);
    if (!ovStore.trim() || base == null || base <= 0) return;
    onChange({ perSiteOverrides: { ...policy.perSiteOverrides, [ovStore.trim()]: base } });
    setOvStore('');
    setOvAmount('');
  };
  const removeOverride = (storeId: string) => {
    const next = { ...policy.perSiteOverrides };
    delete next[storeId];
    onChange({ perSiteOverrides: next });
  };

  return (
    <div className="dig-card" data-testid={`tip-policy-${idPrefix}`} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="dig-toggle-row" style={{ justifyContent: 'space-between' }}>
        <div>
          <span style={{ fontWeight: 600 }}>
            <FormattedMessage id={titleId} />
          </span>
          <p className="dig-muted" style={{ margin: '2px 0 0', fontSize: 12 }}>
            <FormattedMessage id={captionId} />
          </p>
        </div>
        <ToggleSwitch
          checked={policy.enabled}
          onChange={(v) => onChange({ enabled: v })}
          label={intl.formatMessage({ id: 'tip.tab.manage.enable' })}
          testid={`tip-${idPrefix}-enable`}
        />
      </div>

      <label className="dig-field">
        <span>
          <FormattedMessage id="tip.tab.manage.amount" />
        </span>
        <input
          className="dig-input"
          data-testid={`tip-${idPrefix}-amount`}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          value={policy.amount}
          aria-invalid={!amountValid || undefined}
          onChange={(e) => onChange({ amount: e.target.value })}
        />
      </label>

      <span className="dig-muted" style={{ fontSize: 12 }}>
        <FormattedMessage id="tip.tab.manage.mode" />
      </span>
      <SegmentedControl<TipMode>
        value={policy.mode}
        options={MODE_OPTIONS}
        onChange={(m) => onChange({ mode: m })}
        ariaLabel={intl.formatMessage({ id: 'tip.tab.manage.mode' })}
        idPrefix={`tip-${idPrefix}-mode`}
      />

      <label className="dig-field">
        <span>
          <FormattedMessage id="tip.tab.manage.perSiteCap" />
        </span>
        <input
          className="dig-input"
          data-testid={`tip-${idPrefix}-cap`}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          value={policy.perSiteCap}
          aria-invalid={!capValid || undefined}
          onChange={(e) => onChange({ perSiteCap: e.target.value })}
        />
      </label>

      {showOverrides && (
        <div data-testid={`tip-${idPrefix}-overrides`}>
          <span className="dig-muted" style={{ fontSize: 12 }}>
            <FormattedMessage id="tip.tab.manage.overrides" />
          </span>
          {overrides.length > 0 && (
            <ul className="dig-list" style={{ listStyle: 'none', padding: 0, margin: '4px 0' }}>
              {overrides.map(([storeId, base]) => (
                <li
                  key={storeId}
                  data-testid="tip-override-entry"
                  style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' }}
                >
                  <span style={{ flex: 1, fontFamily: 'monospace', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis' }} title={storeId}>
                    {storeId}
                  </span>
                  <span style={{ fontSize: 12 }}>{baseUnitsToDigString(base)} $DIG</span>
                  <button
                    type="button"
                    className="dig-btn dig-btn--sm"
                    data-testid="tip-override-remove"
                    onClick={() => removeOverride(storeId)}
                    aria-label={intl.formatMessage({ id: 'tip.tab.manage.overrides.remove' })}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
            <input
              className="dig-input"
              data-testid="tip-override-store"
              type="text"
              placeholder={intl.formatMessage({ id: 'tip.tab.manage.overrides.store' })}
              aria-label={intl.formatMessage({ id: 'tip.tab.manage.overrides.store' })}
              value={ovStore}
              onChange={(e) => setOvStore(e.target.value)}
              style={{ flex: 1, minWidth: 140 }}
            />
            <input
              className="dig-input"
              data-testid="tip-override-amount"
              type="text"
              inputMode="decimal"
              placeholder={intl.formatMessage({ id: 'tip.tab.manage.overrides.amount' })}
              aria-label={intl.formatMessage({ id: 'tip.tab.manage.overrides.amount' })}
              value={ovAmount}
              onChange={(e) => setOvAmount(e.target.value)}
              style={{ width: 90 }}
            />
            <button
              type="button"
              className="dig-btn dig-btn--sm"
              data-testid="tip-override-add"
              disabled={!ovStore.trim() || !isAmountField(ovAmount) || digStringToBaseUnits(ovAmount) === 0}
              onClick={addOverride}
            >
              <FormattedMessage id="tip.tab.manage.overrides.add" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** The editable auto-tip form, shown only when paired. Seeds its draft from the (open) config read. */
function AutoTipForm({ initial }: { initial: TipConfigForm }) {
  const intl = useIntl();
  const [form, setForm] = useState<TipConfigForm>(initial);
  const [setConfig, saveState] = useSetTipConfigMutation();
  // Re-seed when the persisted config identity changes (e.g. after a save round-trip / external change).
  useEffect(() => setForm(initial), [initial]);

  const patchCreator = (patch: Partial<TipPolicyForm>) => setForm((f) => ({ ...f, creator: { ...f.creator, ...patch } }));
  const patchDev = (patch: Partial<TipPolicyForm>) => setForm((f) => ({ ...f, dev: { ...f.dev, ...patch } }));
  const valid = isTipFormValid(form);
  const dailyValid = isAmountField(form.dailyCap);

  const save = () => {
    const cfg = tipFormToConfig(form);
    if (cfg) void setConfig(cfg);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }} data-testid="tip-manage-form">
      <PolicyEditor
        titleId="tip.tab.manage.creator.title"
        captionId="tip.tab.manage.creator.caption"
        policy={form.creator}
        onChange={patchCreator}
        idPrefix="creator"
        showOverrides
      />
      <PolicyEditor
        titleId="tip.tab.manage.dev.title"
        captionId="tip.tab.manage.dev.caption"
        policy={form.dev}
        onChange={patchDev}
        idPrefix="dev"
        showOverrides={false}
      />

      <label className="dig-field">
        <span>
          <FormattedMessage id="tip.tab.manage.dailyCap" />
        </span>
        <input
          className="dig-input"
          data-testid="tip-daily-cap"
          type="text"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          value={form.dailyCap}
          aria-invalid={!dailyValid || undefined}
          onChange={(e) => setForm((f) => ({ ...f, dailyCap: e.target.value }))}
        />
      </label>

      {!valid && (
        <p className="dig-error-text" role="alert" data-testid="tip-manage-invalid" style={{ margin: 0 }}>
          <FormattedMessage id="tip.tab.manage.invalid" />
        </p>
      )}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          type="button"
          className="dig-btn dig-btn--primary"
          data-testid="tip-manage-save"
          disabled={!valid || saveState.isLoading}
          onClick={save}
        >
          <FormattedMessage id={saveState.isLoading ? 'tip.tab.manage.saving' : 'tip.tab.manage.save'} />
        </button>
        {saveState.isSuccess && (
          <span className="dig-muted" role="status" data-testid="tip-manage-saved">
            <FormattedMessage id="tip.tab.manage.saved" />
          </span>
        )}
        {saveState.isError && (
          <span className="dig-error-text" role="alert" data-testid="tip-manage-save-error">
            {intl.formatMessage({ id: 'tip.tab.manage.saveError' })}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Manage auto-tips (#380) — enable/amount/mode/per-site-cap + per-site overrides for BOTH the content
 * creator and the DIG dev-account (treasury), plus the daily total cap. Reads the node config (open),
 * writes it via the token-gated `tip.set_config` behind the pairing gate. The honest disclosure states
 * plainly it is unattended real-mainnet $DIG within the caps, with one-click-off ($DIG North Star §6.0).
 */
export function ManageAutoTipSection({ nodeOnline }: { nodeOnline: boolean }) {
  const cfg = useGetTipConfigQuery(undefined, { skip: !nodeOnline });
  const form = cfg.data ? tipConfigToForm(cfg.data) : null;

  return (
    <section className="dig-card" data-testid="tip-manage" aria-labelledby="tip-manage-title">
      <h3 className="dig-subheading" id="tip-manage-title" style={{ marginTop: 0 }}>
        <FormattedMessage id="tip.tab.manage.title" />
      </h3>
      <p className="dig-muted" data-testid="tip-manage-disclosure" style={{ marginTop: 0 }}>
        <FormattedMessage id="tip.tab.manage.disclosure" />
      </p>

      {!nodeOnline ? (
        <p className="dig-muted" data-testid="tip-manage-nodedown" style={{ margin: 0 }}>
          <FormattedMessage id="tip.tab.nodeDown" />
        </p>
      ) : (
        <FourState
          isLoading={cfg.isLoading}
          isError={cfg.isError}
          isEmpty={false}
          onRetry={() => void cfg.refetch()}
          errorId="tip.tab.manage.error"
          testid="tip-manage"
        >
          <PairingSection>{form && <AutoTipForm initial={form} />}</PairingSection>
        </FourState>
      )}
    </section>
  );
}
