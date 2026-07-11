import { useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { FourState } from '@/components/FourState';
import { StatusPill } from '@/components/StatusPill';
import { ExternalLink } from '@/components/ExternalLink';
import { controlPanelViewModel } from '@/lib/dig-control';
import { useGetControlStatusQuery } from '@/features/control/controlApi';
import { DIG_INSTALLER_URL } from '@/lib/dig-node-status';
import {
  useGetPeersQuery,
  useConnectPeerMutation,
  useDisconnectPeerMutation,
  useSetPeerBanMutation,
  useSetPoolConfigMutation,
  type PeerInfo,
} from '@/features/peers/peersApi';

const CONNECTION_TYPE_ID: Record<NonNullable<PeerInfo['connection_type']>, string> = {
  direct: 'peers.type.direct',
  hole_punched: 'peers.type.holepunched',
  relayed: 'peers.type.relayed',
};

/** One connected-peer row + its per-peer management actions (disconnect / blacklist / ban). */
function PeerRow({
  peer,
  manage,
  onDisconnect,
  onBlacklist,
  onBan,
}: {
  peer: PeerInfo;
  manage: boolean;
  onDisconnect: (id: string) => void;
  onBlacklist: (id: string) => void;
  onBan: (id: string) => void;
}) {
  const addr = peer.addresses && peer.addresses.length > 0 ? peer.addresses[0] : '—';
  return (
    <tr data-testid="peer-row" data-peer={peer.peer_id}>
      <td style={{ fontFamily: 'monospace', fontSize: 12, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis' }} title={peer.peer_id}>
        {peer.peer_id}
      </td>
      <td style={{ fontFamily: 'monospace', fontSize: 12 }} title={addr}>
        {addr}
      </td>
      <td>{peer.connection_type ? <FormattedMessage id={CONNECTION_TYPE_ID[peer.connection_type]} /> : '—'}</td>
      <td>{typeof peer.latency_ms === 'number' ? <FormattedMessage id="peers.latency.ms" values={{ ms: String(peer.latency_ms) }} /> : '—'}</td>
      <td>{peer.direction ? <FormattedMessage id={peer.direction === 'inbound' ? 'peers.dir.inbound' : 'peers.dir.outbound'} /> : '—'}</td>
      {manage && (
        <td style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button type="button" className="dig-btn dig-btn--sm" data-testid="peer-disconnect" onClick={() => onDisconnect(peer.peer_id)}>
            <FormattedMessage id="peers.action.disconnect" />
          </button>
          <button type="button" className="dig-btn dig-btn--sm" data-testid="peer-blacklist" onClick={() => onBlacklist(peer.peer_id)}>
            <FormattedMessage id="peers.action.blacklist" />
          </button>
          <button type="button" className="dig-btn dig-btn--sm" data-testid="peer-ban" onClick={() => onBan(peer.peer_id)}>
            <FormattedMessage id="peers.action.ban" />
          </button>
        </td>
      )}
    </tr>
  );
}

/**
 * The Peers tab (#393) — a fullscreen-only surface to VIEW + MANAGE the peers the local dig-node is
 * connected to. Consistent with the thin-client model (#365): the dig-node owns peer management
 * (dig-nat + dig-gossip AddressManager); this tab is a FRONTEND driving it over the token-gated
 * `control.*` RPCs (§6.4 RTK Query + four states).
 *
 * Honest capability scoping: today the node answers only `control.peerStatus` (running + count).
 * Per-peer detail + management RPCs are a dig-node follow-up (see {@link peersApi}); until the node
 * advertises `management_supported`, the management controls stay disabled with a plain note, and
 * the per-peer table shows a "needs a newer node" line rather than faking data. Live multi-peer
 * behaviour is additionally gated on the network launch (the pool is dormant pre-launch, #214) —
 * surfaced as a standing note, never as an error.
 */
export function PeersTab() {
  const intl = useIntl();
  const control = useGetControlStatusQuery();
  const vm = control.data ? controlPanelViewModel(control.data) : null;
  const nodeOnline = !!vm?.nodeOnline;

  const peers = useGetPeersQuery(undefined, { skip: !nodeOnline });
  const [connectPeer, connectState] = useConnectPeerMutation();
  const [disconnectPeer] = useDisconnectPeerMutation();
  const [setPeerBan] = useSetPeerBanMutation();
  const [setPoolConfig, poolState] = useSetPoolConfigMutation();

  const [peerInput, setPeerInput] = useState('');
  const [maxConns, setMaxConns] = useState('');

  const data = peers.data;
  const list = data?.peers ?? [];
  const bans = data?.bans ?? [];
  const running = !!data?.running;
  const count = typeof data?.connected_peers === 'number' ? data.connected_peers : null;
  const manage = !!data?.management_supported;

  return (
    <section className="dig-card" data-testid="peers-panel" aria-labelledby="peers-title">
      <h2 className="dig-heading" id="peers-title">
        <FormattedMessage id="peers.title" />
      </h2>
      <p className="dig-muted" style={{ marginTop: 0 }}>
        <FormattedMessage id="peers.intro" />
      </p>

      <FourState
        isLoading={control.isLoading}
        isError={control.isError}
        isEmpty={false}
        onRetry={() => void control.refetch()}
        testid="peers-control"
      >
        {!nodeOnline ? (
          <div data-testid="peers-nodedown" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <p style={{ fontWeight: 600, margin: 0 }}>
              <FormattedMessage id="peers.nodeDown.title" />
            </p>
            <p className="dig-muted" style={{ margin: 0 }}>
              <FormattedMessage id="peers.nodeDown.body" />
            </p>
            <ExternalLink href={DIG_INSTALLER_URL} className="dig-btn dig-btn--primary" testid="peers-install" closePopup>
              <FormattedMessage id="control.install.cta" />
            </ExternalLink>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* Summary */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <StatusPill tone={running ? 'good' : 'neutral'} testid="peers-status">
                <FormattedMessage id={running ? 'control.peers.running' : 'control.peers.idle'} />
              </StatusPill>
              {count != null && (
                <span className="dig-muted" data-testid="peers-count">
                  <FormattedMessage id="control.peers.count" values={{ count: String(count) }} />
                </span>
              )}
            </div>

            {/* Connected-peer list */}
            <div>
              <h4 className="dig-subheading" style={{ marginTop: 0 }}>
                <FormattedMessage id="peers.list.title" />
              </h4>
              <FourState
                isLoading={peers.isLoading}
                isError={peers.isError}
                isEmpty={list.length === 0 && count === 0}
                onRetry={() => void peers.refetch()}
                errorId="peers.error"
                emptyId="peers.list.empty"
                testid="peers-list"
              >
                {list.length > 0 ? (
                  <div style={{ overflowX: 'auto' }}>
                    <table className="dig-table" data-testid="peers-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <thead>
                        <tr>
                          <th style={{ textAlign: 'left' }}><FormattedMessage id="peers.col.peer" /></th>
                          <th style={{ textAlign: 'left' }}><FormattedMessage id="peers.col.address" /></th>
                          <th style={{ textAlign: 'left' }}><FormattedMessage id="peers.col.type" /></th>
                          <th style={{ textAlign: 'left' }}><FormattedMessage id="peers.col.latency" /></th>
                          <th style={{ textAlign: 'left' }}><FormattedMessage id="peers.col.direction" /></th>
                          {manage && <th style={{ textAlign: 'left' }} aria-hidden="true" />}
                        </tr>
                      </thead>
                      <tbody>
                        {list.map((p) => (
                          <PeerRow
                            key={p.peer_id}
                            peer={p}
                            manage={manage}
                            onDisconnect={(id) => void disconnectPeer({ peer: id })}
                            onBlacklist={(id) => void setPeerBan({ peer: id, state: 'blacklist' })}
                            onBan={(id) => void setPeerBan({ peer: id, state: 'ban' })}
                          />
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="dig-muted" data-testid="peers-list-unavailable">
                    <FormattedMessage id="peers.list.unavailable" />
                  </p>
                )}
              </FourState>
            </div>

            {/* Management: manual connect + pool caps + blocked list. Gated on node support. */}
            <div data-testid="peers-manage" aria-disabled={!manage}>
              <h4 className="dig-subheading" style={{ marginTop: 0 }}>
                <FormattedMessage id="peers.connect.title" />
              </h4>
              {!manage && (
                <p className="dig-muted" data-testid="peers-manage-unsupported">
                  <FormattedMessage id="peers.manage.unsupported" />
                </p>
              )}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <input
                  type="text"
                  className="dig-input"
                  data-testid="peers-connect-input"
                  placeholder={intl.formatMessage({ id: 'peers.connect.placeholder' })}
                  aria-label={intl.formatMessage({ id: 'peers.connect.placeholder' })}
                  value={peerInput}
                  disabled={!manage}
                  onChange={(e) => setPeerInput(e.target.value)}
                  style={{ flex: 1, minWidth: 200 }}
                />
                <button
                  type="button"
                  className="dig-btn dig-btn--primary"
                  data-testid="peers-connect-submit"
                  disabled={!manage || connectState.isLoading || !peerInput.trim()}
                  onClick={() => void connectPeer({ peer: peerInput.trim() }).unwrap().then(() => setPeerInput('')).catch(() => {})}
                >
                  <FormattedMessage id="peers.connect.submit" />
                </button>
              </div>

              <h4 className="dig-subheading"><FormattedMessage id="peers.pool.title" /></h4>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <label htmlFor="peers-pool-max">
                  <FormattedMessage id="peers.pool.max" />
                </label>
                <input
                  id="peers-pool-max"
                  type="number"
                  min={0}
                  className="dig-input"
                  data-testid="peers-pool-input"
                  value={maxConns}
                  disabled={!manage}
                  onChange={(e) => setMaxConns(e.target.value)}
                  style={{ width: 100 }}
                />
                <button
                  type="button"
                  className="dig-btn"
                  data-testid="peers-pool-save"
                  disabled={!manage || poolState.isLoading || !maxConns.trim()}
                  onClick={() => void setPoolConfig({ max_connections: Number(maxConns) }).unwrap().catch(() => {})}
                >
                  <FormattedMessage id="peers.pool.save" />
                </button>
              </div>

              <h4 className="dig-subheading"><FormattedMessage id="peers.bans.title" /></h4>
              {bans.length === 0 ? (
                <p className="dig-muted" data-testid="peers-bans-empty">
                  <FormattedMessage id="peers.bans.empty" />
                </p>
              ) : (
                <ul className="dig-list" data-testid="peers-bans" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                  {bans.map((b) => (
                    <li key={b} data-testid="peers-ban-entry" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
                      <span style={{ flex: 1, fontFamily: 'monospace', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis' }} title={b}>
                        {b}
                      </span>
                      <button type="button" className="dig-btn dig-btn--sm" data-testid="peers-unban" disabled={!manage} onClick={() => void setPeerBan({ peer: b, state: 'none' })}>
                        <FormattedMessage id="peers.action.unban" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Pre-launch reality (#214): the pool is dormant until the network launches. */}
            <p className="dig-muted" data-testid="peers-prelaunch" style={{ fontSize: 12, marginBottom: 0 }}>
              <FormattedMessage id="peers.prelaunch" />
            </p>
          </div>
        )}
      </FourState>
    </section>
  );
}
