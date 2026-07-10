import { useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { FourState } from '@/components/FourState';
import { StatusPill } from '@/components/StatusPill';
import {
  useGetNodeConfigQuery,
  useSetUpstreamMutation,
  useListHostedStoresQuery,
  useUnpinStoreMutation,
  useGetSyncStatusQuery,
  useGetPeerStatusQuery,
} from '@/features/control/controlApi';
import { formatBytes } from '@/lib/dig-cache';

/** Upstream (control.config.get / setUpstream): view + set the DIG RPC the node proxies/syncs to. */
export function UpstreamSection() {
  const intl = useIntl();
  const cfg = useGetNodeConfigQuery();
  const [setUpstream, setState] = useSetUpstreamMutation();
  const [value, setValue] = useState('');

  return (
    <section className="dig-card" data-testid="control-upstream" aria-labelledby="control-upstream-title">
      <h4 className="dig-subheading" id="control-upstream-title">
        <FormattedMessage id="control.upstream.title" />
      </h4>
      <FourState isLoading={cfg.isLoading} isError={cfg.isError} isEmpty={false} onRetry={() => void cfg.refetch()} testid="control-upstream">
        <p className="dig-muted" data-testid="control-upstream-current" style={{ wordBreak: 'break-all' }}>
          <FormattedMessage id="control.upstream.current" values={{ url: cfg.data?.upstream ?? '—' }} />
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input
            type="url"
            className="dig-input"
            data-testid="control-upstream-input"
            placeholder="https://rpc.dig.net/"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-label={intl.formatMessage({ id: 'control.upstream.title' })}
            style={{ flex: 1, minWidth: 160 }}
          />
          <button
            type="button"
            className="dig-btn dig-btn--primary"
            data-testid="control-upstream-set"
            disabled={setState.isLoading || !value.trim()}
            onClick={() => void setUpstream({ upstream: value.trim() }).unwrap().then(() => setValue('')).catch(() => {})}
          >
            <FormattedMessage id="control.upstream.set" />
          </button>
        </div>
      </FourState>
    </section>
  );
}

/** Hosted stores (control.hostedStores.list / unpin). */
export function HostedStoresSection() {
  const q = useListHostedStoresQuery();
  const [unpin] = useUnpinStoreMutation();
  const stores = q.data?.stores ?? [];
  return (
    <section className="dig-card" data-testid="control-stores" aria-labelledby="control-stores-title">
      <h4 className="dig-subheading" id="control-stores-title">
        <FormattedMessage id="control.stores.title" />
      </h4>
      <FourState
        isLoading={q.isLoading}
        isError={q.isError}
        isEmpty={stores.length === 0}
        onRetry={() => void q.refetch()}
        emptyId="control.stores.empty"
        testid="control-stores"
      >
        <ul className="dig-list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {stores.map((s) => (
            <li
              key={s.store_id}
              data-testid="control-store-entry"
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid var(--dig-border, #3333)' }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'monospace', fontSize: 12 }} title={s.store_id}>
                  {s.store_id}
                </div>
                <div className="dig-muted" style={{ fontSize: 12 }}>
                  <FormattedMessage
                    id="control.stores.meta"
                    values={{ count: String(s.capsule_count), size: formatBytes(s.total_bytes) }}
                  />
                </div>
              </div>
              {s.pinned && (
                <StatusPill tone="good" testid="control-store-pinned">
                  <FormattedMessage id="control.stores.pinned" />
                </StatusPill>
              )}
              <button
                type="button"
                className="dig-btn dig-btn--sm"
                data-testid="control-store-unpin"
                onClick={() => void unpin({ store: s.store_id })}
              >
                <FormattedMessage id="control.stores.unpin" />
              </button>
            </li>
          ))}
        </ul>
      </FourState>
    </section>
  );
}

/** §21 sync (control.sync.status). */
export function SyncSection() {
  const q = useGetSyncStatusQuery();
  return (
    <section className="dig-card" data-testid="control-sync" aria-labelledby="control-sync-title">
      <h4 className="dig-subheading" id="control-sync-title">
        <FormattedMessage id="control.sync.title" />
      </h4>
      <FourState isLoading={q.isLoading} isError={q.isError} isEmpty={false} onRetry={() => void q.refetch()} testid="control-sync">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <StatusPill tone={q.data?.available ? 'good' : 'neutral'} testid="control-sync-pill">
            <FormattedMessage id={q.data?.available ? 'control.sync.available' : 'control.sync.unavailable'} />
          </StatusPill>
          {typeof q.data?.pinned_total === 'number' && (
            <span className="dig-muted" data-testid="control-sync-coverage">
              <FormattedMessage
                id="control.sync.coverage"
                values={{ synced: String(q.data?.pinned_synced ?? 0), total: String(q.data?.pinned_total ?? 0) }}
              />
            </span>
          )}
        </div>
      </FourState>
    </section>
  );
}

/** Peers (control.peerStatus). */
export function PeersSection() {
  const q = useGetPeerStatusQuery();
  const running = !!q.data?.running;
  const peers = typeof q.data?.connected_peers === 'number' ? (q.data.connected_peers as number) : null;
  return (
    <section className="dig-card" data-testid="control-peers" aria-labelledby="control-peers-title">
      <h4 className="dig-subheading" id="control-peers-title">
        <FormattedMessage id="control.peers.title" />
      </h4>
      <FourState isLoading={q.isLoading} isError={q.isError} isEmpty={false} onRetry={() => void q.refetch()} testid="control-peers">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <StatusPill tone={running ? 'good' : 'neutral'} testid="control-peers-pill">
            <FormattedMessage id={running ? 'control.peers.running' : 'control.peers.idle'} />
          </StatusPill>
          {peers != null && (
            <span className="dig-muted" data-testid="control-peers-count">
              <FormattedMessage id="control.peers.count" values={{ count: String(peers) }} />
            </span>
          )}
        </div>
      </FourState>
    </section>
  );
}
