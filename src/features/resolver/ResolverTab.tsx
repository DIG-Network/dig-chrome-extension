import { useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { resolveViaStatus } from '@/lib/resolve-status';
import { digDnsIndicatorView } from '@/lib/dig-dns-status';
import { ACTIONS } from '@/lib/messages';
import { FourState } from '@/components/FourState';
import { StatusPill } from '@/components/StatusPill';
import { useStorageValue } from '@/lib/useStorageValue';
import { hasRuntime, sendAction } from '@/lib/messaging';
import { useGetNodeStatusQuery, useSaveNodeHostMutation, useGetDigDnsStatusQuery } from '@/features/resolver/resolverApi';

/** Poll the SW's dig-dns signal often enough that the indicator tracks a live engage/recover. */
const DIG_DNS_STATUS_POLL_MS = 15_000;

const HOST_KEY = 'server.host';
const ENABLED_KEY = 'extensionEnabled';

/**
 * The Resolver tab (§7 content path) — the extension's core surface: open a chia:// address,
 * toggle chia:// resolution, see the honest "Resolving via" §5.3 verdict, and set a custom node.
 * Reuses the pure `resolve-status` view-model + the background `getDigNodeStatus` probe so the
 * verdict can never drift. Behavior + the v1.5.1 store-HTML SW routing are unchanged.
 */
export function ResolverTab() {
  const intl = useIntl();
  const [enabled, setEnabled] = useStorageValue<boolean>(ENABLED_KEY, true);
  const [host, setHost] = useStorageValue<string>(HOST_KEY, '');
  const nodeStatus = useGetNodeStatusQuery();
  const [saveHost, saveState] = useSaveNodeHostMutation();
  const digDnsStatus = useGetDigDnsStatusQuery(undefined, { pollingInterval: DIG_DNS_STATUS_POLL_MS });
  const digDnsView = digDnsIndicatorView(digDnsStatus.data);

  const [url, setUrl] = useState('');
  const [hostDraft, setHostDraft] = useState<string | null>(null);
  const draft = hostDraft ?? host;

  const openUrl = () => {
    const raw = url.trim();
    if (!raw) return;
    const chiaUrl = raw.startsWith('chia://') ? raw : `chia://${raw}`;
    if (hasRuntime() && chrome.tabs) {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const id = tabs[0]?.id;
        if (id != null) {
          void chrome.tabs.update(id, { url: chiaUrl });
          try {
            window.close();
          } catch {
            /* ignore */
          }
        }
      });
    }
  };

  const toggle = (next: boolean) => {
    setEnabled(next);
    void sendAction({ action: ACTIONS.toggleExtension, enabled: next }).catch(() => {});
  };

  const onSaveHost = () => {
    setHost(draft.trim());
    void saveHost({ host: draft.trim() });
    setHostDraft(null);
  };

  const via = resolveViaStatus(nodeStatus.data ?? { reachable: false, base: null }, { customHost: host });

  return (
    <section className="dig-card" data-testid="resolver-panel" aria-labelledby="resolver-title">
      <h2 className="dig-heading" id="resolver-title">
        <FormattedMessage id="resolver.title" />
      </h2>

      <div className="dig-field">
        <label htmlFor="chia-url-input">
          <FormattedMessage id="resolver.url.label" />
        </label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            id="chia-url-input"
            className="dig-input dig-mono"
            data-testid="chia-url-input"
            placeholder={intl.formatMessage({ id: 'resolver.url.placeholder' })}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && openUrl()}
          />
          <button type="button" className="dig-btn dig-btn--primary" data-testid="chia-url-go" onClick={openUrl}>
            <FormattedMessage id="resolver.go" />
          </button>
        </div>
      </div>

      <div className="dig-toggle-row" style={{ marginTop: 4 }}>
        <label htmlFor="resolution-toggle">
          <FormattedMessage id="resolver.toggle.label" />
        </label>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
          <StatusPill tone={enabled ? 'good' : 'neutral'} testid="status-text">
            <FormattedMessage id={enabled ? 'resolver.status.active' : 'resolver.status.inactive'} />
          </StatusPill>
          <input
            id="resolution-toggle"
            type="checkbox"
            data-testid="resolution-toggle"
            checked={enabled}
            onChange={(e) => toggle(e.target.checked)}
            aria-label={intl.formatMessage({ id: 'resolver.toggle.label' })}
          />
        </span>
      </div>

      <div style={{ marginTop: 16 }}>
        <div className="dig-section-title">
          <FormattedMessage id="resolver.via.label" />
        </div>
        <FourState
          isLoading={nodeStatus.isLoading}
          isError={false}
          isEmpty={false}
          loadingId="resolver.via.loading"
          testid="resolve-status-state"
        >
          <div data-testid="resolve-status" data-tier={via.tier}>
            {via.label}
          </div>
        </FourState>
      </div>

      <div style={{ marginTop: 16 }}>
        <div className="dig-section-title">
          <FormattedMessage id="resolver.digdns.label" />
        </div>
        <FourState
          isLoading={digDnsStatus.isLoading}
          isError={false}
          isEmpty={false}
          loadingId="resolver.digdns.loading"
          testid="digdns-status-state"
        >
          <StatusPill tone={digDnsView.tone} testid="digdns-status-pill">
            <FormattedMessage id={digDnsView.labelId} />
          </StatusPill>
        </FourState>
      </div>

      <div className="dig-field" style={{ marginTop: 16 }}>
        <label htmlFor="node-host-input">
          <FormattedMessage id="resolver.node.label" />
        </label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            id="node-host-input"
            className="dig-input dig-mono"
            data-testid="node-host-input"
            placeholder={intl.formatMessage({ id: 'resolver.node.placeholder' })}
            value={draft}
            onChange={(e) => setHostDraft(e.target.value)}
          />
          <button type="button" className="dig-btn" data-testid="node-host-save" onClick={onSaveHost} disabled={saveState.isLoading}>
            <FormattedMessage id="resolver.node.save" />
          </button>
        </div>
      </div>
    </section>
  );
}
