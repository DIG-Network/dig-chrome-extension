import { FormattedMessage } from 'react-intl';
import { StatusPill } from '@/components/StatusPill';
import { useGetNodeLiveStatusQuery } from '@/features/control/nodeApi';
import { liveStatusToneId } from '@/features/control/liveStatus';
import type { NodeWsConnState } from '@/lib/dig-node-ws';

/**
 * Live node-status section (#239): reflects the SW's WebSocket liveness in real time — Connected
 * (with node addr + version), Connecting, or Disconnected — updating with no user action. A polite
 * live region announces transitions to a screen reader.
 */
export function LiveStatusSection() {
  const { data } = useGetNodeLiveStatusQuery();
  const state: NodeWsConnState = data?.state ?? 'disconnected';
  const { tone, id } = liveStatusToneId(state);

  return (
    <section className="dig-card" data-testid="control-live" aria-labelledby="control-live-title">
      <h3 className="dig-heading" id="control-live-title">
        <FormattedMessage id="control.live.title" />
      </h3>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }} role="status" aria-live="polite">
        <StatusPill tone={tone} testid="control-live-pill">
          <FormattedMessage id={id} />
        </StatusPill>
        {state === 'connected' && (
          <span className="dig-muted" data-testid="control-live-detail">
            {data?.addr ?? ''}
            {data?.version ? ` · v${data.version}` : ''}
          </span>
        )}
      </div>
    </section>
  );
}

/** A COMPACT live indicator for the popup header (pill only). */
export function LiveStatusPill() {
  const { data } = useGetNodeLiveStatusQuery();
  const state: NodeWsConnState = data?.state ?? 'disconnected';
  const { tone, id } = liveStatusToneId(state);
  return (
    <StatusPill tone={tone} testid="header-node-pill">
      <FormattedMessage id={id} />
    </StatusPill>
  );
}
