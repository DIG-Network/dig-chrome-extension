import { describe, it, expect, vi } from 'vitest';
import {
  createWalletControlWsController,
  walletWsUrlFor,
  initialWalletSyncStatus,
  WalletWsRequestError,
  WALLET_WS_ERR,
  type SentRequestFrame,
} from '@/lib/dig-node-wallet-ws';
import type { WebSocketLike } from '@/lib/dig-node-ws';

/** A controllable fake `/ws` socket: captures sent request frames + lets the test push node frames. */
class FakeSocket implements WebSocketLike {
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  closed = false;
  sent: SentRequestFrame[] = [];

  constructor(public url: string) {}

  send(data: string): void {
    this.sent.push(JSON.parse(data) as SentRequestFrame);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.({});
  }

  emit(frame: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

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
    runLatest: () => scheduled.pop()?.fn(),
    /** Fire the FIRST scheduled callback with the given ms (used to trip a request timeout). */
    runFirstWithMs: (ms: number) => {
      const idx = scheduled.findIndex((s) => s.ms === ms);
      if (idx >= 0) scheduled.splice(idx, 1)[0].fn();
    },
  };
}

/** Boot a controller with a fake socket + scheduler and drive it to the `connected` state. */
async function connectedController(opts: Partial<Parameters<typeof createWalletControlWsController>[0]> = {}) {
  const sockets: FakeSocket[] = [];
  const scheduler = fakeScheduler();
  const controller = createWalletControlWsController({
    resolveBase: async () => 'http://dig.local',
    createSocket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    ...scheduler,
    ...opts,
  });
  controller.start();
  await Promise.resolve();
  await Promise.resolve();
  // The FIRST frame (any) flips connState → connected.
  sockets[0].emit({ type: 'sync_status', state: 'synced', peak_height: 100, target_height: 100 });
  return { controller, sockets, scheduler };
}

describe('walletWsUrlFor', () => {
  it('maps http(s) bases to the /ws transport (not /ws/status)', () => {
    expect(walletWsUrlFor('http://dig.local')).toBe('ws://dig.local/ws');
    expect(walletWsUrlFor('http://localhost:9778')).toBe('ws://localhost:9778/ws');
    expect(walletWsUrlFor('https://node:9000/')).toBe('wss://node:9000/ws');
  });
});

describe('initialWalletSyncStatus', () => {
  it('starts disconnected with no known heights', () => {
    expect(initialWalletSyncStatus(7)).toEqual({ state: 'disconnected', peakHeight: null, targetHeight: null, updatedAt: 7 });
  });
});

describe('createWalletControlWsController — connection lifecycle', () => {
  it('opens the /ws socket and flips to connected on the first frame', async () => {
    const { controller, sockets } = await connectedController();
    expect(sockets).toHaveLength(1);
    expect(sockets[0].url).toBe('ws://dig.local/ws');
    expect(controller.isConnected()).toBe(true);
    expect(controller.getConnState()).toBe('connected');
  });

  it('reports disconnected (not stuck connecting) when no node is reachable', async () => {
    const scheduler = fakeScheduler();
    const controller = createWalletControlWsController({ resolveBase: async () => null, ...scheduler });
    controller.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.getConnState()).toBe('disconnected');
    expect(controller.getSyncStatus().state).toBe('disconnected');
    expect(scheduler.delays()).toHaveLength(1); // a reconnect was scheduled
  });
});

describe('request/response correlation (#372)', () => {
  it('assigns a unique id per request and resolves the matching ok:true response with result', async () => {
    const { controller, sockets } = await connectedController();
    const p1 = controller.request('get_cats');
    const p2 = controller.request('get_nfts');
    expect(sockets[0].sent.map((f) => f.method)).toEqual(['get_cats', 'get_nfts']);
    const [id1, id2] = sockets[0].sent.map((f) => f.id);
    expect(id1).not.toBe(id2);

    // Reply to the SECOND request first — correlation must not be order-dependent.
    sockets[0].emit({ type: 'response', id: id2, ok: true, result: { nfts: [] } });
    sockets[0].emit({ type: 'response', id: id1, ok: true, result: { cats: [{ asset_id: 'aa' }] } });

    await expect(p1).resolves.toEqual({ cats: [{ asset_id: 'aa' }] });
    await expect(p2).resolves.toEqual({ nfts: [] });
  });

  it('rejects an ok:false response with the node error code + message', async () => {
    const { controller, sockets } = await connectedController();
    const p = controller.request('control.sync.status');
    const id = sockets[0].sent[0].id;
    sockets[0].emit({ type: 'response', id, ok: false, error: { code: -32030, message: 'unauthorized' } });
    await expect(p).rejects.toMatchObject({ code: -32030, message: 'unauthorized' });
    await expect(p).rejects.toBeInstanceOf(WalletWsRequestError);
  });

  it('rejects immediately (NOT_CONNECTED) when the socket is down — the SW then falls back to HTTP', async () => {
    const scheduler = fakeScheduler();
    const controller = createWalletControlWsController({ resolveBase: async () => null, ...scheduler });
    controller.start();
    await Promise.resolve();
    await expect(controller.request('get_cats')).rejects.toMatchObject({ code: WALLET_WS_ERR.NOT_CONNECTED });
  });

  it('rejects a request with TIMEOUT when no response arrives in time', async () => {
    const { controller, sockets, scheduler } = await connectedController({ resolveBase: async () => 'http://dig.local', requestTimeoutMs: 5000 });
    const p = controller.request('get_sync_status');
    expect(sockets[0].sent).toHaveLength(1);
    scheduler.runFirstWithMs(5000); // trip the request timeout
    await expect(p).rejects.toMatchObject({ code: WALLET_WS_ERR.TIMEOUT });
  });

  it('rejects all in-flight requests when the socket closes', async () => {
    const { controller, sockets } = await connectedController();
    const p = controller.request('get_coins');
    sockets[0].close();
    await expect(p).rejects.toMatchObject({ code: WALLET_WS_ERR.SOCKET_CLOSED });
    expect(controller.getConnState()).toBe('disconnected');
  });

  it('attaches the paired token to the request frame when getToken yields one', async () => {
    const { controller, sockets } = await connectedController({ resolveBase: async () => 'http://dig.local', getToken: () => 'tok-123' });
    void controller.request('control.hostedStores.list');
    await Promise.resolve(); // the send is deferred past the awaited getToken()
    await Promise.resolve();
    expect(sockets[0].sent[0].token).toBe('tok-123');
  });

  it('omits the token for the open bootstrap ops when no token is available', async () => {
    const { controller, sockets } = await connectedController({ resolveBase: async () => 'http://dig.local', getToken: () => null });
    void controller.request('pairing.request', { client_name: 'x' });
    await Promise.resolve();
    await Promise.resolve();
    expect(sockets[0].sent[0].token).toBeUndefined();
  });
});

describe('sync_status + event pushes (#373)', () => {
  it('maps a syncing sync_status with peak/target heights', async () => {
    const seen: string[] = [];
    const { controller, sockets } = await connectedController({ resolveBase: async () => 'http://dig.local' });
    controller.subscribeSyncStatus((s) => seen.push(s.state));
    sockets[0].emit({ type: 'sync_status', state: 'syncing', peak_height: 42, target_height: 100 });
    const s = controller.getSyncStatus();
    expect(s.state).toBe('syncing');
    expect(s.peakHeight).toBe(42);
    expect(s.targetHeight).toBe(100);
    expect(seen).toContain('syncing');
  });

  it('treats an unknown sync_status state as syncing (forward-compatible)', async () => {
    const { controller, sockets } = await connectedController();
    sockets[0].emit({ type: 'sync_status', state: 'weird-future-state' });
    expect(controller.getSyncStatus().state).toBe('syncing');
  });

  it('forwards each pushed SyncEvent to onEvent', async () => {
    const events: unknown[] = [];
    const sockets: FakeSocket[] = [];
    const scheduler = fakeScheduler();
    const controller = createWalletControlWsController({
      resolveBase: async () => 'http://dig.local',
      createSocket: (url) => { const s = new FakeSocket(url); sockets.push(s); return s; },
      onEvent: (e) => events.push(e),
      ...scheduler,
    });
    controller.start();
    await Promise.resolve();
    await Promise.resolve();
    sockets[0].emit({ type: 'event', event: { type: 'coin_state' } });
    expect(events).toEqual([{ type: 'coin_state' }]);
  });

  it('forces sync status to disconnected the moment the socket drops (never a stale synced)', async () => {
    const { controller, sockets } = await connectedController();
    expect(controller.getSyncStatus().state).toBe('synced');
    sockets[0].close();
    const s = controller.getSyncStatus();
    expect(s.state).toBe('disconnected');
    expect(s.peakHeight).toBeNull();
  });
});

describe('reconnect + stop', () => {
  it('reconnects with a new socket after a drop and re-connects on the next frame', async () => {
    const { controller, sockets, scheduler } = await connectedController();
    sockets[0].close();
    expect(controller.getConnState()).toBe('disconnected');
    scheduler.runLatest(); // fire the reconnect timer
    await Promise.resolve();
    await Promise.resolve();
    expect(sockets).toHaveLength(2);
    sockets[1].emit({ type: 'sync_status', state: 'synced', peak_height: 200, target_height: 200 });
    expect(controller.getConnState()).toBe('connected');
    expect(controller.getSyncStatus().peakHeight).toBe(200);
  });

  it('stop() closes the socket, cancels timers, and rejects in-flight requests', async () => {
    const { controller, sockets, scheduler } = await connectedController();
    const p = controller.request('get_dids');
    controller.stop();
    await expect(p).rejects.toMatchObject({ code: WALLET_WS_ERR.SOCKET_CLOSED });
    expect(sockets[0].closed).toBe(true);
    expect(controller.getConnState()).toBe('disconnected');
    // No reconnect after stop.
    scheduler.runLatest();
    await Promise.resolve();
    expect(sockets).toHaveLength(1);
  });

  it('subscribe/unsubscribe stops delivering sync-status updates', async () => {
    const { controller, sockets } = await connectedController();
    const seen: string[] = [];
    const unsub = controller.subscribeSyncStatus((s) => seen.push(s.state));
    unsub();
    sockets[0].emit({ type: 'sync_status', state: 'syncing' });
    expect(seen).toEqual([]);
  });

  it('force-closes a stale connected socket that goes silent past the staleness window', async () => {
    vi.useFakeTimers();
    try {
      const sockets: FakeSocket[] = [];
      const controller = createWalletControlWsController({
        resolveBase: async () => 'http://dig.local',
        createSocket: (url) => { const s = new FakeSocket(url); sockets.push(s); return s; },
        staleAfterMs: 1000,
      });
      controller.start();
      await vi.advanceTimersByTimeAsync(0);
      sockets[0].emit({ type: 'sync_status', state: 'synced' });
      expect(controller.getConnState()).toBe('connected');
      await vi.advanceTimersByTimeAsync(1100);
      expect(sockets[0].closed).toBe(true);
      expect(controller.getConnState()).toBe('disconnected');
    } finally {
      vi.useRealTimers();
    }
  });
});
