import { FormattedMessage } from 'react-intl';
import { controlPanelViewModel } from '@/lib/dig-control';
import { DIG_BROWSER_URL } from '@/lib/links';
import { FourState } from '@/components/FourState';
import { StatusPill } from '@/components/StatusPill';
import { ExternalLink } from '@/components/ExternalLink';
import { useGetControlStatusQuery } from '@/features/control/controlApi';

/**
 * The Control tab (DIG Control Panel — dig://control parity): detect a local dig-node and branch
 * manage vs install. Reuses the pure `controlPanelViewModel` so the manage/install presentation +
 * honest read-fallback line can't drift; full (token-gated) management deep-links to the native DIG
 * Browser. Four states.
 */
export function ControlTab() {
  const control = useGetControlStatusQuery();
  const vm = control.data ? controlPanelViewModel(control.data) : null;

  return (
    <section
      className="dig-card"
      data-testid="control-panel"
      data-mode={vm?.mode ?? ''}
      aria-labelledby="control-title"
    >
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
        {vm && (
          <div>
            <div style={{ marginBottom: 12 }}>
              <StatusPill tone={vm.nodeOnline ? 'good' : 'neutral'} testid="control-node-state">
                <FormattedMessage id={vm.nodeOnline ? 'control.node.online' : 'control.node.offline'} />
              </StatusPill>
            </div>

            {vm.mode === 'manage' ? (
              <>
                {vm.hasStats && vm.stats && (
                  <div className="dig-row" data-testid="control-stats">
                    <div className="dig-row-main">
                      <div className="dig-muted">
                        Hosted stores: {String(vm.stats.hostedStores)} · Cached: {String(vm.stats.cachedCapsules)}
                      </div>
                    </div>
                  </div>
                )}
                <p className="dig-muted" data-testid="control-manage-note">
                  {vm.note}
                </p>
                <ExternalLink href={DIG_BROWSER_URL} className="dig-btn dig-btn--block" testid="control-get-browser" closePopup>
                  <FormattedMessage id="control.getBrowser" />
                </ExternalLink>
              </>
            ) : (
              <>
                <p style={{ fontWeight: 600, margin: '0 0 4px' }}>{vm.install.title}</p>
                <p className="dig-muted" data-testid="control-install-note">
                  {vm.install.body}
                </p>
                <ExternalLink href={vm.install.installUrl} className="dig-btn dig-btn--primary dig-btn--block" testid="control-install" closePopup>
                  <FormattedMessage id="control.install.cta" />
                </ExternalLink>
              </>
            )}
            <p className="dig-muted" data-testid="control-read-fallback" style={{ marginTop: 12 }}>
              {vm.readFallbackLine}
            </p>
          </div>
        )}
      </FourState>
    </section>
  );
}
