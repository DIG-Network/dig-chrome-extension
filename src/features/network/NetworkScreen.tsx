import { FormattedMessage } from 'react-intl';
import { SegmentedControl } from '@/components/SegmentedControl';
import { useAppDispatch, useAppSelector } from '@/app/hooks';
import { setNetworkView } from '@/features/ui/uiSlice';
import { NETWORK_VIEWS, type NetworkView } from '@/app/tabs';
import { ResolverTab } from '@/features/resolver/ResolverTab';
import { ShieldTab } from '@/features/shield/ShieldTab';
import { ControlTab } from '@/features/control/ControlTab';

const SEG_OPTIONS = NETWORK_VIEWS.map((v) => ({ value: v, labelId: `network.view.${v}` }));

/**
 * The Network screen (#65) — the Fable "Network" grouping that hosts the three ambient/pull-on-
 * failure surfaces (Resolver | Shield | Control) behind one bottom-nav item, via a segmented
 * sub-control. The active sub-view is cross-document client state (`ui.networkView`); legacy
 * `#resolver`/`#shield`/`#control` deep-links still land here on the right sub-view (see tabs.ts).
 */
export function NetworkScreen() {
  const dispatch = useAppDispatch();
  const networkView = useAppSelector((s) => s.ui.networkView);
  return (
    <section data-testid="network-panel" aria-labelledby="network-title">
      <div className="dig-toggle-row" style={{ marginBottom: 14 }}>
        <h2 className="dig-heading" id="network-title" style={{ margin: 0 }}>
          <FormattedMessage id="tab.network" />
        </h2>
      </div>
      <div className="dig-toggle-row" style={{ marginBottom: 14 }}>
        <SegmentedControl<NetworkView>
          value={networkView}
          options={SEG_OPTIONS}
          onChange={(v) => dispatch(setNetworkView(v))}
          ariaLabel="Network views"
          idPrefix="network"
        />
      </div>
      <div role="tabpanel" id={`network-panel-${networkView}`} aria-labelledby={`network-tab-${networkView}`} tabIndex={0}>
        {networkView === 'resolver' && <ResolverTab />}
        {networkView === 'shield' && <ShieldTab />}
        {networkView === 'control' && <ControlTab />}
      </div>
    </section>
  );
}
