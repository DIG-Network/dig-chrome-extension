import { describe, it, expect } from 'vitest';
import { liveStatusToneId } from '@/features/control/liveStatus';

describe('liveStatusToneId', () => {
  it('maps connection states to tone + message id', () => {
    expect(liveStatusToneId('connected')).toEqual({ tone: 'good', id: 'control.live.connected' });
    expect(liveStatusToneId('connecting')).toEqual({ tone: 'neutral', id: 'control.live.connecting' });
    expect(liveStatusToneId('disconnected')).toEqual({ tone: 'bad', id: 'control.live.disconnected' });
  });
});
