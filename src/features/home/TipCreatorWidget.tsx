import { useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { useAppDispatch } from '@/app/hooks';
import { setTab, setWalletView } from '@/features/ui/uiSlice';
import { useStorageValue } from '@/lib/useStorageValue';
import { useGetShieldLedgerQuery } from '@/features/shield/shieldApi';
import { useTipCreatorMutation } from '@/features/home/tipApi';
import {
  AUTOTIP_CONFIG_KEY,
  DEFAULT_AUTOTIP_CONFIG,
  normalizeAutoTipConfig,
  isAutoTipConfigured,
  isValidTipAmount,
  resolveTipAmount,
  type AutoTipConfig,
} from '@/lib/autoTip';

/**
 * Home-tab "tip the creator" widget (#379, child of #377). $DIG North Star (§6.0): a frictionless,
 * opt-in, one-tap, dismissible prompt to send the creator of the DIG resource on the active tab a
 * little $DIG — it NEVER gates consumption. It shows ONLY when a DIG-protocol resource is loaded on
 * the active tab (the capsule from the Shield ledger) AND auto-tip is not already configured (when
 * auto-tip is on, the node handles tipping unattended, so the manual prompt would be noise). The
 * per-tap execution routes to the dig-node tipping subsystem (#377) via `tipCreator`; that subsystem
 * is not built yet, so a tap surfaces the honest "coming soon" error — the UI + config are complete
 * now and light up the moment the node ships.
 */
export function TipCreatorWidget() {
  const dispatch = useAppDispatch();
  const intl = useIntl();
  // Refetch on mount so the prompt reflects the DIG resource on the CURRENT active tab, and so this
  // early subscription never leaves a stale ledger cached for the Shield panel (#307/#134) to read.
  const { data } = useGetShieldLedgerQuery(undefined, { refetchOnMountOrArgChange: true });
  const capsule = data?.capsule ?? null;
  const [rawCfg] = useStorageValue<AutoTipConfig>(AUTOTIP_CONFIG_KEY, DEFAULT_AUTOTIP_CONFIG);
  const cfg = normalizeAutoTipConfig(rawCfg);
  const [dismissed, setDismissed] = useState(false);
  const [tip, { isLoading, isError, isSuccess, reset }] = useTipCreatorMutation();
  const [amountDraft, setAmountDraft] = useState<string | null>(null);

  // Hidden unless a DIG resource is loaded; hidden when auto-tip is configured (node handles it);
  // hidden once dismissed this session. Returning null keeps the Home board unchanged on normal pages.
  if (!capsule || isAutoTipConfigured(cfg) || dismissed) return null;

  const amount = amountDraft ?? resolveTipAmount(cfg, capsule.storeId);
  const valid = isValidTipAmount(amount);

  const goSetup = () => {
    dispatch(setWalletView('home'));
    dispatch(setTab('wallet'));
  };

  return (
    <section
      className="dig-widget dig-widget--tip"
      data-testid="tip-creator-widget"
      aria-labelledby="tip-creator-title"
    >
      <span className="dig-widget-label" id="tip-creator-title">
        <FormattedMessage id="tip.creator.title" />
      </span>

      {isSuccess ? (
        <p className="dig-muted" role="status" data-testid="tip-creator-success" style={{ margin: '4px 0 0' }}>
          <FormattedMessage id="tip.creator.sent" />
        </p>
      ) : (
        <>
          <p className="dig-muted" style={{ margin: '2px 0 8px' }}>
            <FormattedMessage id="tip.creator.subtitle" />
          </p>

          <label className="dig-field" style={{ marginBottom: 8 }}>
            <span>
              <FormattedMessage id="tip.creator.amount.label" />
            </span>
            <input
              className="dig-input"
              data-testid="tip-creator-amount"
              type="text"
              inputMode="decimal"
              autoComplete="off"
              spellCheck={false}
              value={amount}
              aria-invalid={!valid || undefined}
              onChange={(e) => {
                setAmountDraft(e.target.value);
                if (isError) reset();
              }}
            />
          </label>

          <div className="dig-toggle-row" style={{ gap: 8, display: 'flex', flexWrap: 'wrap' }}>
            <button
              type="button"
              className="dig-btn dig-btn--primary"
              data-testid="tip-creator-send"
              disabled={!valid || isLoading}
              onClick={() => {
                if (valid) void tip({ storeId: capsule.storeId, amountDig: amount });
              }}
            >
              <FormattedMessage
                id={isLoading ? 'tip.creator.sending' : 'tip.creator.send'}
                values={{ amount }}
              />
            </button>
            <button type="button" className="dig-btn" data-testid="tip-creator-setup" onClick={goSetup}>
              <FormattedMessage id="tip.creator.setup" />
            </button>
            <button
              type="button"
              className="dig-link"
              data-testid="tip-creator-dismiss"
              onClick={() => setDismissed(true)}
            >
              <FormattedMessage id="tip.creator.dismiss" />
            </button>
          </div>

          {isError && (
            <p
              className="dig-error-text"
              role="alert"
              data-testid="tip-creator-error"
              style={{ margin: '8px 0 0' }}
            >
              {intl.formatMessage({ id: 'tip.creator.error' })}
            </p>
          )}
        </>
      )}
    </section>
  );
}
