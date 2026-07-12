import { FormattedMessage } from 'react-intl';
import { FourState } from '@/components/FourState';
import { controlPanelViewModel } from '@/lib/dig-control';
import { useGetControlStatusQuery } from '@/features/control/controlApi';
import { TipHistorySection } from '@/features/tipping/TipHistorySection';
import { ManageAutoTipSection } from '@/features/tipping/ManageAutoTipSection';
import { XchtipButtonSection } from '@/features/tipping/XchtipButtonSection';

/**
 * The fullscreen Tip tab (#380, child of #377) — the rich management surface over the dig-node tipping
 * subsystem (SPEC §18.23). Three sections:
 *   1. TIP HISTORY — the node's tip ledger by timeframe (`tip.get_ledger`, live-patched by the pushed
 *      `{type:"tip"}` frame). Node-dependent.
 *   2. MANAGE AUTO-TIPS — read/write the auto-tip policy (creator + DIG dev-account) via
 *      `tip.get_config`/`tip.set_config`, behind the pairing gate, with the honest one-click-off
 *      disclosure ($DIG North Star §6.0). Node-dependent.
 *   3. YOUR TIP BUTTON — generate an xchtip.app tip button/link for the user's own XCH so OTHERS can
 *      tip THEM. Wallet-dependent, NOT node-dependent.
 *
 * Fullscreen-only (§145 surface tiering) — the popup links here, never embeds these advanced forms.
 * #428 caveat: actual tip SPEND no-ops until the node's live broadcaster lands, so the ledger stays
 * empty + manual tips return "skipped"; the sections render that honestly (informative empty-state +
 * a standing "coming soon" note), never as a broken view.
 */
export function TippingTab() {
  const control = useGetControlStatusQuery();
  const vm = control.data ? controlPanelViewModel(control.data) : null;
  const nodeOnline = !!vm?.nodeOnline;

  return (
    <section className="dig-card" data-testid="tipping-panel" aria-labelledby="tipping-title">
      <h2 className="dig-heading" id="tipping-title">
        <FormattedMessage id="tip.tab.title" />
      </h2>
      <p className="dig-muted" style={{ marginTop: 0 }}>
        <FormattedMessage id="tip.tab.intro" />
      </p>

      {/* #428: tipping execution activates once the node wallet can send — set the expectation up front. */}
      <p className="dig-muted" data-testid="tipping-activation-note" style={{ fontSize: 12, marginTop: 0 }}>
        <FormattedMessage id="tip.tab.activationNote" />
      </p>

      <FourState
        isLoading={control.isLoading}
        isError={control.isError}
        isEmpty={false}
        onRetry={() => void control.refetch()}
        testid="tipping-control"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <TipHistorySection nodeOnline={nodeOnline} />
          <ManageAutoTipSection nodeOnline={nodeOnline} />
          <XchtipButtonSection />
        </div>
      </FourState>
    </section>
  );
}
