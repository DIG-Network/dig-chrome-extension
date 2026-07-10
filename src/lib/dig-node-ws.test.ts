import { describe, it, expect, vi } from 'vitest';
import {
  createNodeWsController,
  wsUrlFor,
  nextReconnectDelayMs,
  initialNodeLiveStatus,
  type WebSocketLike,
} from '@/lib/dig-node-ws';

/** A controllable fake `WebSocketLike` the test drives directly (open/message/close), with no
 * real socket/DOM — mirrors the fake-fetch idiom `dig-dns.test.ts` already uses for its
 * chrome-free controller. */
class FakeSocket implements WebSocketLike {
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  closed = false;

  constructor(public url: string) {}

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.({});
  }

  emitMessage(frame: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

/** A fake scheduler: `run()` fires the MOST RECENTLY scheduled callback (what the controller
 * always wants next — reconnect or stale-watchdog), `ms` records every scheduled delay so tests
 * can assert backoff growth without real timers. */
function fakeScheduler() {
  const scheduled: { fn: () => void; ms: number }[] = [];
  return {
    scheduleTimeout: (fn: () => void, ms: number) => {
      const handle = { fn, ms };
      scheduled.push(handle);
      return handle;
    },
    clearScheduledTimeout: (handle: unknown) => {
      const idx = scheduled.indexOf(handle as { fn: () => void; ms: number });
      if (idx >= 0) scheduled.splice(idx, 1);
    },
    delays: () => scheduled.map((s) => s.ms),
    runLatest: () => {
      const next = scheduled.pop();
      next?.fn();
    },
  };
}

describe('wsUrlFor', () => {
  it('maps http(s) bases to ws(s) + /ws/status', () => {
    expect(wsUrlFor('http://dig.local')).toBe('ws://dig.local/ws/status');
    expect(wsUrlFor('http://localhost:9778')).toBe('ws://localhost:9778/ws/status');
    expect(wsUrlFor('https://my-node.example.com:9000')).toBe('wss://my-node.example.com:9000/ws/status');
  });

  it('tolerates a trailing slash on the base', () => {
    expect(wsUrlFor('http://dig.local/')).toBe('ws://dig.local/ws/status');
  });
});

describe('nextReconnectDelayMs', () => {
  it('grows exponentially and caps at maxMs', () => {
    const opts = { baseMs: 1000, maxMs: 8000, random: () => 0 };
    // random()=0 → the fixed half only: exp/2.
    expect(nextReconnectDelayMs(0, opts)).toBe(500); // exp=1000
    expect(nextReconnectDelayMs(1, opts)).toBe(1000); // exp=2000
    expect(nextReconnectDelayMs(2, opts)).toBe(2000); // exp=4000
    expect(nextReconnectDelayMs(3, opts)).toBe(4000); // exp=8000 (cap)
    expect(nextReconnectDelayMs(10, opts)).toBe(4000); // still capped
  });

  it('jitters between the fixed half and the full exponential value', () => {
    const atZero = nextReconnectDelayMs(2, { baseMs: 1000, maxMs: 8000, random: () => 0 });
    const atOne = nextReconnectDelayMs(2, { baseMs: 1000, maxMs: 8000, random: () => 1 });
    expect(atZero).toBe(2000); // exp/2
    expect(atOne).toBe(4000); // exp/2 + 1*exp/2 = exp
  });
});

describe('initialNodeLiveStatus', () => {
  it('starts disconnected with no known node fields', () => {
    const s = initialNodeLiveStatus(123);
    expect(s).toEqual({ state: 'disconnected', base: null, addr: null, version: null, commit: null, updatedAt: 123 });
  });
});

describe('createNodeWsController — the up→down→up reconnect state machine (#239)', () => {
  it('transitions connecting → connected on the initial snapshot frame', async () => {
    const sockets: FakeSocket[] = [];
    const scheduler = fakeScheduler();
    const statuses: string[] = [];
    const controller = createNodeWsController({
      resolveBase: async () => 'http://dig.local',
      createSocket: (url) => {
        const s = new FakeSocket(url);
        sockets.push(s);
        return s;
      },
      onStatusChange: (s) => statuses.push(s.state),
      ...scheduler,
    });

    controller.start();
    await Promise.resolve(); // let the resolveBase() microtask settle
    await Promise.resolve();

    expect(sockets).toHaveLength(1);
    expect(sockets[0].url).toBe('ws://dig.local/ws/status');
    expect(controller.getStatus().state).toBe('connecting');

    sockets[0].emitMessage({ type: 'status', service: 'dig-node', version: '0.11.0', commit: 'abc123', addr: '127.0.0.1:9778' });

    const status = controller.getStatus();
    expect(status.state).toBe('connected');
    expect(status.addr).toBe('127.0.0.1:9778');
    expect(status.version).toBe('0.11.0');
    expect(status.base).toBe('http://dig.local');
    expect(statuses).toEqual(['connecting', 'connected']);
  });

  it('goes DOWN on socket close (offline) and schedules a reconnect', async () => {
    const sockets: FakeSocket[] = [];
    const scheduler = fakeScheduler();
    const controller = createNodeWsController({
      resolveBase: async () => 'http://dig.local',
      createSocket: (url) => {
        const s = new FakeSocket(url);
        sockets.push(s);
        return s;
      },
      ...scheduler,
    });

    controller.start();
    await Promise.resolve();
    await Promise.resolve();
    sockets[0].emitMessage({ type: 'status', version: '0.11.0', addr: '127.0.0.1:9778' });
    expect(controller.getStatus().state).toBe('connected');

    sockets[0].close();

    const status = controller.getStatus();
    expect(status.state).toBe('disconnected');
    expect(status.addr).toBeNull();
    expect(status.version).toBeNull();
    expect(scheduler.delays()).toHaveLength(1); // a reconnect was scheduled
  });

  it('comes back UP after the node returns — offline → online, no manual reconnect needed', async () => {
    const sockets: FakeSocket[] = [];
    const scheduler = fakeScheduler();
    const controller = createNodeWsController({
      resolveBase: async () => 'http://dig.local',
      createSocket: (url) => {
        const s = new FakeSocket(url);
        sockets.push(s);
        return s;
      },
      ...scheduler,
    });

    controller.start();
    await Promise.resolve();
    await Promise.resolve();
    sockets[0].emitMessage({ type: 'status', version: '0.11.0', addr: '127.0.0.1:9778' });
    sockets[0].close(); // node goes offline
    expect(controller.getStatus().state).toBe('disconnected');

    scheduler.runLatest(); // fire the scheduled reconnect (as if the backoff timer elapsed)
    await Promise.resolve();
    await Promise.resolve();

    expect(sockets).toHaveLength(2); // a NEW socket for the reconnect attempt
    expect(controller.getStatus().state).toBe('connecting');

    sockets[1].emitMessage({ type: 'status', version: '0.11.1', addr: '127.0.0.1:9778' });
    expect(controller.getStatus().state).toBe('connected');
    expect(controller.getStatus().version).toBe('0.11.1');
  });

  it('grows the reconnect delay across repeated failures with no success in between', async () => {
    const sockets: FakeSocket[] = [];
    const scheduler = fakeScheduler();
    const controller = createNodeWsController({
      resolveBase: async () => 'http://dig.local',
      createSocket: (url) => {
        const s = new FakeSocket(url);
        sockets.push(s);
        return s;
      },
      random: () => 0, // deterministic: exp/2 each time
      baseReconnectDelayMs: 1000,
      maxReconnectDelayMs: 8000,
      ...scheduler,
    });

    controller.start();
    await Promise.resolve();
    await Promise.resolve();
    sockets[0].close(); // fails before ever connecting

    scheduler.runLatest();
    await Promise.resolve();
    await Promise.resolve();
    sockets[1].close(); // fails again — no success in between

    scheduler.runLatest();
    await Promise.resolve();
    await Promise.resolve();
    sockets[2].close();

    // Each failure (no intervening success) at least doubles the previous delay.
    const delays = scheduler.delays();
    expect(delays.length).toBeGreaterThanOrEqual(1);
    for (let i = 1; i < delays.length; i += 1) {
      expect(delays[i]).toBeGreaterThan(delays[i - 1]);
    }
  });

  it('reports disconnected (not stuck connecting forever) when no local node is reachable', async () => {
    const scheduler = fakeScheduler();
    const controller = createNodeWsController({
      resolveBase: async () => null,
      ...scheduler,
    });

    controller.start();
    await Promise.resolve();
    await Promise.resolve();

    const status = controller.getStatus();
    expect(status.state).toBe('disconnected');
    expect(status.base).toBeNull();
    expect(scheduler.delays()).toHaveLength(1);
  });

  it('force-closes and reconnects a stale connected socket that never sends another frame', async () => {
    vi.useFakeTimers();
    try {
      const sockets: FakeSocket[] = [];
      const controller = createNodeWsController({
        resolveBase: async () => 'http://dig.local',
        createSocket: (url) => {
          const s = new FakeSocket(url);
          sockets.push(s);
          return s;
        },
        staleAfterMs: 1000,
      });

      controller.start();
      await vi.advanceTimersByTimeAsync(0);
      sockets[0].emitMessage({ type: 'status', version: '0.11.0', addr: '127.0.0.1:9778' });
      expect(controller.getStatus().state).toBe('connected');

      // No further frame arrives — advance past the staleness window.
      await vi.advanceTimersByTimeAsync(1100);

      expect(sockets[0].closed).toBe(true); // the controller force-closed the stale socket
      expect(controller.getStatus().state).toBe('disconnected');
    } finally {
      vi.useRealTimers();
    }
  });

  it('subscribe/unsubscribe: a listener stops receiving updates after unsubscribing', async () => {
    const sockets: FakeSocket[] = [];
    const scheduler = fakeScheduler();
    const controller = createNodeWsController({
      resolveBase: async () => 'http://dig.local',
      createSocket: (url) => {
        const s = new FakeSocket(url);
        sockets.push(s);
        return s;
      },
      ...scheduler,
    });
    const seen: string[] = [];
    const unsubscribe = controller.subscribe((s) => seen.push(s.state));

    controller.start();
    await Promise.resolve();
    await Promise.resolve();
    unsubscribe();
    sockets[0].emitMessage({ type: 'status', version: '0.11.0', addr: '127.0.0.1:9778' });

    expect(seen).toEqual(['connecting']); // the 'connected' transition was NOT delivered post-unsubscribe
  });

  it('stop() closes the socket and cancels the pending reconnect (no further sockets created)', async () => {
    const sockets: FakeSocket[] = [];
    const scheduler = fakeScheduler();
    const controller = createNodeWsController({
      resolveBase: async () => 'http://dig.local',
      createSocket: (url) => {
        const s = new FakeSocket(url);
        sockets.push(s);
        return s;
      },
      ...scheduler,
    });

    controller.start();
    await Promise.resolve();
    await Promise.resolve();
    controller.stop();

    expect(sockets[0].closed).toBe(true);
    expect(scheduler.delays()).toHaveLength(0);

    // Even if a stray timer somehow fired, stop() must prevent a new connect cycle.
    scheduler.runLatest();
    await Promise.resolve();
    await Promise.resolve();
    expect(sockets).toHaveLength(1);
  });
});
