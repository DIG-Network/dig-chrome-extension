import { FormattedMessage } from 'react-intl';
import { controlPanelViewModel } from '@/lib/dig-control';
import { FourState } from '@/components/FourState';
import { ExternalLink } from '@/components/ExternalLink';
import { useMediaQuery } from '@/lib/useMediaQuery';
import { popOutToFullpage } from '@/lib/popout';
import { EXPANDED_MIN_WIDTH } from '@/app/layout';
import { useGetControlStatusQuery } from '@/features/control/controlApi';
import { LiveStatusSection } from '@/features/control/LiveStatusSection';
import { CacheSection } from '@/features/control/CacheSection';
import { PairingSection } from '@/features/control/PairingSection';
import {
  UpstreamSection,
  HostedStoresSection,
  SyncSection,
  PeersSection,
} from '@/features/control/ManageSections';

/**
 * The DIG Control Panel (dig://control, #278/#281). Detects the local dig-node; when absent it
 * shows the install prompt (reads still resolve via the hosted network). When present it renders:
 *   - the FULL panel on the fullscreen app view (live status + cache/LRU + the paired management
 *     sections behind the pairing gate), and
 *   - a COMPACT summary in the constrained popup (live status + cache/LRU + an "Open the full
 *     Control Panel" link to `app.html#network/control`).
 * §6.4 tiering: all advanced management is fullscreen; the popup stays streamlined.
 */
export function ControlTab() {
  const control = useGetControlStatusQuery();
  const vm = control.data ? controlPanelViewModel(control.data) : null;
  const wide = useMediaQuery(`(min-width: ${EXPANDED_MIN_WIDTH}px)`);
  // The full (all-sections) panel renders only on the fullscreen `app.html` entry AND when wide —
  // the toolbar popup is inherently constrained (Chromium caps it), so it always shows the compact
  // summary + an "open the full panel" link, never the fullscreen-only paired management sections.
  const isFullPage = typeof window !== 'undefined' && window.location.pathname.includes('app.html');
  const full = isFullPage && wide;

  return (
    <section className="dig-card" data-testid="control-panel" data-mode={vm?.mode ?? ''} aria-labelledby="control-title">
      <h2 className="dig-heading" id="control-title">
        <FormattedMessage id="control.title" />
      </h2>
      <FourState
        isLoading={control.isLoading}
        isError={control.isError}
        isEmpty={false}
        onRetry={() => void control.refetch()}
        loadingId="control.loading"
        testid="control"
      >
        {vm && vm.mode === 'install' && (
          <div>
            <p style={{ fontWeight: 600, margin: '0 0 4px' }}>
              <FormattedMessage id={vm.install.titleId} />
            </p>
            <p className="dig-muted" data-testid="control-install-note">
              <FormattedMessage id={vm.install.bodyId} />
            </p>
            <ExternalLink href={vm.install.installUrl} className="dig-btn dig-btn--primary dig-btn--block" testid="control-install" closePopup>
              <FormattedMessage id="control.install.cta" />
            </ExternalLink>
            <p className="dig-muted" data-testid="control-read-fallback" style={{ marginTop: 12 }}>
              <FormattedMessage id={vm.readFallback.id} values={vm.readFallback.values} />
            </p>
          </div>
        )}

        {vm && vm.mode === 'manage' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <LiveStatusSection />
            <CacheSection />
            {full ? (
              <PairingSection>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }}>
                  <UpstreamSection />
                  <HostedStoresSection />
                  <SyncSection />
                  <PeersSection />
                </div>
              </PairingSection>
            ) : (
              <button
                type="button"
                className="dig-btn dig-btn--block"
                data-testid="control-open-full"
                onClick={() => void popOutToFullpage('#network/control', true)}
              >
                <FormattedMessage id="control.openFull" />
              </button>
            )}
          </div>
        )}
      </FourState>
    </section>
  );
}
