import { describe, it, expect, vi } from 'vitest';
import {
  createPairingController,
  pairingViewModel,
  initialPairingState,
  type PairingControllerDeps,
  type PairingPollResult,
} from '@/lib/dig-pairing';

/** A fake scheduler: `runNext()` fires the most-recently scheduled callback (the poll). */
function fakeScheduler() {
  const scheduled: { fn: () => void }[] = [];
  return {
    scheduleTimeout: (fn: () => void) => {
      const h = { fn };
      scheduled.push(h);
      return h;
    },
    clearScheduledTimeout: (h: unknown) => {
      const i = scheduled.indexOf(h as { fn: () => void });
      if (i >= 0) scheduled.splice(i, 1);
    },
    runNext: async () => {
      const next = scheduled.pop();
      if (next) await next.fn();
    },
    pending: () => scheduled.length,
  };
}

function makeController(overrides: Partial<PairingControllerDeps> = {}) {
  const saved: { token: string | null } = { token: null };
  const sched = fakeScheduler();
  const deps: PairingControllerDeps = {
    requestPairing: vi.fn(async () => ({ pairing_id: 'pid123', pairing_code: '481920', expires_ms: Date.now() + 60_000 })),
    pollPairing: vi.fn(async (): Promise<PairingPollResult | null> => ({ status: 'pending' })),
    loadToken: vi.fn(async () => saved.token),
    saveToken: vi.fn(async (t: string | null) => { saved.token = t; }),
    scheduleTimeout: sched.scheduleTimeout,
    clearScheduledTimeout: sched.clearScheduledTimeout,
    pollIntervalMs: 10,
    ...overrides,
  };
  const ctrl = createPairingController(deps);
  return { ctrl, deps, sched, saved };
}

describe('createPairingController', () => {
  it('hydrates to unpaired with no stored token, paired with one', async () => {
    const a = makeController();
    await a.ctrl.hydrate();
    expect(a.ctrl.getState().phase).toBe('unpaired');

    const b = makeController({ loadToken: async () => 'stored-token' });
    await b.ctrl.hydrate();
    expect(b.ctrl.getState().phase).toBe('paired');
    expect(b.ctrl.getToken()).toBe('stored-token');
  });

  it('request → awaiting (shows code) → poll approved → paired + token saved', async () => {
    let polls = 0;
    const { ctrl, saved, sched } = makeController({
      pollPairing: async () => {
        polls += 1;
        return polls === 1 ? { status: 'pending' } : { status: 'approved', token: 'scoped-tok' };
      },
    });
    await ctrl.startPairing();
    expect(ctrl.getState().phase).toBe('awaiting');
    expect(ctrl.getState().pairingCode).toBe('481920');
    expect(ctrl.getState().pairingId).toBe('pid123');

    await sched.runNext(); // poll #1 → pending, reschedules
    expect(ctrl.getState().phase).toBe('awaiting');
    await sched.runNext(); // poll #2 → approved
    expect(ctrl.getState().phase).toBe('paired');
    expect(ctrl.getToken()).toBe('scoped-tok');
    expect(saved.token).toBe('scoped-tok');
  });

  it('poll expired → expired phase', async () => {
    const { ctrl, sched } = makeController({
      pollPairing: async () => ({ status: 'expired' }),
    });
    await ctrl.startPairing();
    await sched.runNext();
    expect(ctrl.getState().phase).toBe('expired');
  });

  it('request transport failure → error phase', async () => {
    const { ctrl } = makeController({ requestPairing: async () => null });
    await ctrl.startPairing();
    expect(ctrl.getState().phase).toBe('error');
  });

  it('unpair clears the token → unpaired', async () => {
    const { ctrl, saved } = makeController({ loadToken: async () => 'tok' });
    await ctrl.hydrate();
    expect(ctrl.getState().phase).toBe('paired');
    await ctrl.unpair();
    expect(ctrl.getState().phase).toBe('unpaired');
    expect(ctrl.getToken()).toBeNull();
    expect(saved.token).toBeNull();
  });

  it('cancel while awaiting drops back to unpaired and stops polling', async () => {
    const { ctrl, sched } = makeController();
    await ctrl.startPairing();
    expect(sched.pending()).toBe(1);
    ctrl.cancel();
    expect(ctrl.getState().phase).toBe('unpaired');
    // A straggling poll from the cancelled cycle does not resurrect awaiting.
    await sched.runNext();
    expect(ctrl.getState().phase).toBe('unpaired');
  });
});

describe('pairingViewModel', () => {
  it('maps each phase to ids + button flags', () => {
    const unpaired = pairingViewModel(initialPairingState());
    expect(unpaired.showPairButton).toBe(true);
    expect(unpaired.showUnpairButton).toBe(false);

    const awaiting = pairingViewModel({
      phase: 'awaiting', pairingId: 'pid', pairingCode: '123456', expiresMs: 1, error: null, updatedAt: 0,
    });
    expect(awaiting.code).toBe('123456');
    expect(awaiting.pairingId).toBe('pid');
    expect(awaiting.showCancelButton).toBe(true);

    const paired = pairingViewModel({
      phase: 'paired', pairingId: null, pairingCode: null, expiresMs: null, error: null, updatedAt: 0,
    });
    expect(paired.tone).toBe('good');
    expect(paired.showUnpairButton).toBe(true);
  });
});
