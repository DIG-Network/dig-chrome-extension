import type { PillTone } from '@/components/StatusPill';
import type { NodeWsConnState } from '@/lib/dig-node-ws';

/** Map the WS connection state to a status-pill tone + a message id (pure; unit-testable). */
export function liveStatusToneId(state: NodeWsConnState): { tone: PillTone; id: string } {
  switch (state) {
    case 'connected':
      return { tone: 'good', id: 'control.live.connected' };
    case 'connecting':
      return { tone: 'neutral', id: 'control.live.connecting' };
    case 'disconnected':
    default:
      return { tone: 'bad', id: 'control.live.disconnected' };
  }
}
