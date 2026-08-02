import { describe, it, expect, vi } from 'vitest';
import {
  createWsReconnectLoop,
  nextReconnectDelayMs,
  DEFAULT_BASE_RECONNECT_DELAY_MS,
  DEFAULT_MAX_RECONNECT_DELAY_MS,
  DEFAULT_STALE_AFTER_MS,
  type WebSocketLike,
  type WsProtocol,
  type WsConnectionHandlers,
} from '@/lib/ws-reconnect-core';

/** A controllable fake socket the test drives directly (message/close) — no real socket/DOM. */
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
  emit(data: unknown): void {
    this.onmessage?.({ data });
  }
}

/** A fake scheduler: `runLatest()` fires the most-recently-scheduled callback (reconnect or stale
 * watchdog), `delays()` records every scheduled delay so tests can assert the exact backoff. */
function fakeScheduler() {
  const scheduled: { fn: () => void; ms: number }[] = [];
  /** Every delay EVER scheduled, in order — survives runLatest() pops (unlike `scheduled`). */
  const allDelays: number[] = [];
  return {
    scheduleTimeout: (fn: () => void, ms: number) => {
      const handle = { fn, ms };
      scheduled.push(handle);
      allDelays.push(ms);
      return handle;
    },
    clearScheduledTimeout: (handle: unknown) => {
      const idx = scheduled.indexOf(handle as { fn: () => void; ms: number });
      if (idx >= 0) scheduled.splice(idx, 1);
    },
    delays: () => scheduled.map((s) => s.ms),
    allDelays: () => allDelays.slice(),
    runLatest: () => scheduled.pop()?.fn(),
    pending: () => scheduled.length,
  };
}

/** A minimal recording protocol so a test can watch the loop's callback ordering + drive frames. */
function recordingProtocol(overrides: Partial<WsProtocol> = {}) {
  const events: string[] = [];
  const sockets: FakeSocket[] = [];
  const protocol: WsProtocol = {
    urlForBase: (base) => `ws://${base}/x`,
    onNoBase: () => events.push('noBase'),
    connect: (base): WsConnectionHandlers => {
      events.push(`connect:${base}`);
      return {
        onMessage: (data, ctx) => {
          events.push(`msg:${String(data)}`);
          ctx.markAlive();
        },
        onClose: () => events.push('close'),
      };
    },
    onStop: () => events.push('stop'),
    ...overrides,
  };
  return { events, sockets, protocol };
}

const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('nextReconnectDelayMs — the exact backoff schedule (timing contract)', () => {
  it('is min(maxMs, baseMs*2^attempt), equal-jitter (fixed half + random*half)', () => {
    const opts = { baseMs: 1000, maxMs: 8000, random: () => 0 };
    // random()=0 → fixed half only = exp/2.
    expect(nextReconnectDelayMs(0, opts)).toBe(500); // exp=1000
    expect(nextReconnectDelayMs(1, opts)).toBe(1000); // exp=2000
    expect(nextReconnectDelayMs(2, opts)).toBe(2000); // exp=4000
    expect(nextReconnectDelayMs(3, opts)).toBe(4000); // exp=8000 (cap)
    expect(nextReconnectDelayMs(4, opts)).toBe(4000); // exp capped at 8000 → 4000
    expect(nextReconnectDelayMs(50, opts)).toBe(4000); // still capped, no overflow
  });

  it('random()=1 yields the full exponential (upper jitter bound); mid = fixed + mid*half', () => {
    const opts = { baseMs: 1000, maxMs: 8000 };
    expect(nextReconnectDelayMs(2, { ...opts, random: () => 1 })).toBe(4000); // exp/2 + 1*exp/2 = exp
    expect(nextReconnectDelayMs(2, { ...opts, random: () => 0.5 })).toBe(3000); // 2000 + 0.5*2000
  });

  it('negative/zero attempts clamp to attempt 0 (never a sub-base delay)', () => {
    const opts = { baseMs: 1000, maxMs: 30000, random: () => 1 };
    expect(nextReconnectDelayMs(-5, opts)).toBe(1000); // clamped to 2^0
    expect(nextReconnectDelayMs(0, opts)).toBe(1000);
  });

  it('exposes the published default bounds', () => {
    expect(DEFAULT_BASE_RECONNECT_DELAY_MS).toBe(1000);
    expect(DEFAULT_MAX_RECONNECT_DELAY_MS).toBe(30000);
    expect(DEFAULT_STALE_AFTER_MS).toBe(20000);
  });
});

describe('createWsReconnectLoop — backoff growth across repeated failures', () => {
  it('emits the EXACT doubling schedule 500,1000,2000,4000,4000 (base=1000,max=8000,random=0)', async () => {
    const scheduler = fakeScheduler();
    const sockets: FakeSocket[] = [];
    const { protocol } = recordingProtocol();
    const loop = createWsReconnectLoop({
      resolveBase: async () => 'node',
      protocol,
      createSocket: (url) => {
        const s = new FakeSocket(url);
        sockets.push(s);
        return s;
      },
      random: () => 0,
      baseReconnectDelayMs: 1000,
      maxReconnectDelayMs: 8000,
      scheduleTimeout: scheduler.scheduleTimeout,
      clearScheduledTimeout: scheduler.clearScheduledTimeout,
    });

    loop.start();
    await settle();
    // Fail before any frame ever arrives, five times, with NO success in between.
    for (let i = 0; i < 5; i += 1) {
      sockets[i].close();
      scheduler.runLatest();
      await settle();
    }
    // attempt increments 0..4 → delays are the fixed half of min(8000, 1000*2^attempt).
    expect(scheduler.allDelays()).toEqual([500, 1000, 2000, 4000, 4000]);
  });

  it('a successful frame RESETS the backoff to base (attempt→0) before the next failure', async () => {
    const scheduler = fakeScheduler();
    const sockets: FakeSocket[] = [];
    const { protocol } = recordingProtocol();
    const loop = createWsReconnectLoop({
      resolveBase: async () => 'node',
      protocol,
      createSocket: (url) => {
        const s = new FakeSocket(url);
        sockets.push(s);
        return s;
      },
      random: () => 0,
      baseReconnectDelayMs: 1000,
      maxReconnectDelayMs: 8000,
      scheduleTimeout: scheduler.scheduleTimeout,
      clearScheduledTimeout: scheduler.clearScheduledTimeout,
    });

    loop.start();
    await settle();
    sockets[0].close(); // fail #1 → delay 500 (attempt 0)
    scheduler.runLatest();
    await settle();
    sockets[1].close(); // fail #2 → delay 1000 (attempt 1)
    scheduler.runLatest();
    await settle();
    // Now succeed: a live frame resets attempt to 0 (markAlive), so the NEXT failure is 500 again.
    sockets[2].emit('{"ok":1}'); // a live frame → markAlive resets attempt to 0 (and arms the watchdog)
    sockets[2].close(); // fail #3 → next reconnect delay must be back to 500, proving the reset
    const delays = scheduler.allDelays();
    expect(delays[delays.length - 1]).toBe(500);
  });
});

describe('createWsReconnectLoop — staleness watchdog (client-side half-open detection)', () => {
  it('force-closes a connected socket that goes silent past staleAfterMs, then reconnects', async () => {
    vi.useFakeTimers();
    try {
      const sockets: FakeSocket[] = [];
      const { protocol, events } = recordingProtocol();
      const loop = createWsReconnectLoop({
        resolveBase: async () => 'node',
        protocol,
        createSocket: (url) => {
          const s = new FakeSocket(url);
          sockets.push(s);
          return s;
        },
        staleAfterMs: 1000,
      });

      loop.start();
      await vi.advanceTimersByTimeAsync(0);
      sockets[0].emit('{"type":"heartbeat"}'); // markAlive arms the 1000ms watchdog
      expect(sockets[0].closed).toBe(false);

      await vi.advanceTimersByTimeAsync(999);
      expect(sockets[0].closed).toBe(false); // just under the window — still alive

      await vi.advanceTimersByTimeAsync(2); // cross 1000ms
      expect(sockets[0].closed).toBe(true); // watchdog force-closed the half-open socket
      expect(events).toContain('close'); // and the protocol's onClose ran (reconnect scheduled)
    } finally {
      vi.useRealTimers();
    }
  });

  it('each inbound frame RE-ARMS the watchdog (a steady heartbeat never trips it)', async () => {
    vi.useFakeTimers();
    try {
      const sockets: FakeSocket[] = [];
      const { protocol } = recordingProtocol();
      const loop = createWsReconnectLoop({
        resolveBase: async () => 'node',
        protocol,
        createSocket: (url) => {
          const s = new FakeSocket(url);
          sockets.push(s);
          return s;
        },
        staleAfterMs: 1000,
      });

      loop.start();
      await vi.advanceTimersByTimeAsync(0);
      // A frame every 800ms (< 1000ms window) five times → never stale.
      for (let i = 0; i < 5; i += 1) {
        await vi.advanceTimersByTimeAsync(800);
        sockets[0].emit('{"type":"heartbeat"}');
      }
      expect(sockets[0].closed).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('createWsReconnectLoop — no-base retry + protocol callback ordering', () => {
  it('calls onNoBase and schedules a retry when resolveBase yields null', async () => {
    const scheduler = fakeScheduler();
    const { protocol, events } = recordingProtocol();
    const loop = createWsReconnectLoop({
      resolveBase: async () => null,
      protocol,
      scheduleTimeout: scheduler.scheduleTimeout,
      clearScheduledTimeout: scheduler.clearScheduledTimeout,
    });

    loop.start();
    await settle();
    expect(events).toEqual(['noBase']);
    expect(scheduler.delays()).toHaveLength(1); // a retry was scheduled
  });

  it('drives connect→message on a resolvable base, in order', async () => {
    const scheduler = fakeScheduler();
    const sockets: FakeSocket[] = [];
    const { protocol, events } = recordingProtocol();
    const loop = createWsReconnectLoop({
      resolveBase: async () => 'dig.local',
      protocol,
      createSocket: (url) => {
        const s = new FakeSocket(url);
        sockets.push(s);
        return s;
      },
      scheduleTimeout: scheduler.scheduleTimeout,
      clearScheduledTimeout: scheduler.clearScheduledTimeout,
    });

    loop.start();
    await settle();
    expect(sockets[0].url).toBe('ws://dig.local/x'); // urlForBase applied
    sockets[0].emit('hello');
    expect(events).toEqual(['connect:dig.local', 'msg:hello']);
  });
});

describe('createWsReconnectLoop — cycle guard + stop teardown', () => {
  it('start() is idempotent (a second call while running opens no extra socket)', async () => {
    const sockets: FakeSocket[] = [];
    const { protocol } = recordingProtocol();
    const loop = createWsReconnectLoop({
      resolveBase: async () => 'node',
      protocol,
      createSocket: (url) => {
        const s = new FakeSocket(url);
        sockets.push(s);
        return s;
      },
    });

    loop.start();
    loop.start();
    await settle();
    expect(sockets).toHaveLength(1);
    expect(loop.isRunning()).toBe(true);
  });

  it('stop() closes the socket, cancels the pending reconnect, and runs onStop()', async () => {
    const scheduler = fakeScheduler();
    const sockets: FakeSocket[] = [];
    const { protocol, events } = recordingProtocol();
    const loop = createWsReconnectLoop({
      resolveBase: async () => 'node',
      protocol,
      createSocket: (url) => {
        const s = new FakeSocket(url);
        sockets.push(s);
        return s;
      },
      scheduleTimeout: scheduler.scheduleTimeout,
      clearScheduledTimeout: scheduler.clearScheduledTimeout,
    });

    loop.start();
    await settle();
    loop.stop();

    expect(sockets[0].closed).toBe(true);
    expect(loop.isRunning()).toBe(false);
    expect(loop.getSocket()).toBeNull();
    expect(events).toContain('stop');
    // onStop must NOT re-fire the connection's onClose (the close event is cycle-guarded).
    expect(events.filter((e) => e === 'close')).toHaveLength(0);
    expect(scheduler.pending()).toBe(0); // no reconnect left armed

    // A stray fired timer after stop() must not spawn a new connect cycle.
    scheduler.runLatest();
    await settle();
    expect(sockets).toHaveLength(1);
  });

  it('a straggling frame from a socket whose cycle was superseded is ignored', async () => {
    const scheduler = fakeScheduler();
    const sockets: FakeSocket[] = [];
    const { protocol, events } = recordingProtocol();
    const loop = createWsReconnectLoop({
      resolveBase: async () => 'node',
      protocol,
      createSocket: (url) => {
        const s = new FakeSocket(url);
        sockets.push(s);
        return s;
      },
      scheduleTimeout: scheduler.scheduleTimeout,
      clearScheduledTimeout: scheduler.clearScheduledTimeout,
    });

    loop.start();
    await settle();
    const stale = sockets[0];
    loop.stop(); // cycleId bumped → stale's handlers are now from a superseded cycle
    const before = events.length;
    stale.emit('late-frame');
    expect(events.length).toBe(before); // onMessage did NOT run for the superseded socket
  });
});
