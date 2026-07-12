/**
 * dig-node WALLET+CONTROL WebSocket client (#372) — the SW's persistent bidirectional connection to
 * the local dig-node's `GET /ws` transport (dig-node SPEC §4.8, shipped v0.20.0). This is the
 * transport half of the "extension = thin frontend to the node" epic (#365): ALL wallet READS and
 * every `control.*`/`pairing.*` op ride ONE socket with request/response correlation, and the node
 * PROACTIVELY PUSHES `sync_status` + sync `event`s on the same socket — replacing the per-call HTTP
 * POST path (`node-wallet.ts` / `controlAuthed`) whenever the socket is up. The `chia://` RESOLVER
 * transport is UNCHANGED and does NOT use this socket (epic §3).
 *
 * # Wire (dig-node SPEC §4.8) — JSON text frames
 *   client→node: `{ type:"request", id, method, params, token? }`   (`id` correlates the reply)
 *   node→client: `{ type:"response", id, ok, result?, error? }`
 *                `{ type:"sync_status", state, peak_height?, target_height? }`  (PUSH, on connect + transitions)
 *                `{ type:"event", event }`                                       (PUSH, SyncEvent tagged union)
 *
 * Authorization (§7.12): wallet READS are open; every wallet MUTATION + `control.*` REQUIRES the
 * frame's `token` (the paired control token, #280). The SW injects {@link WalletWsControllerDeps.getToken};
 * `pairing.request`/`pairing.poll` are open (the bootstrap) so a request may omit the token.
 *
 * This module is CHROME-FREE + DOM-free (every dependency injected — socket ctor, clock, RNG, timer
 * scheduler, base resolver, token getter), so the whole state machine + correlation logic is
 * unit-testable under vitest with a fake `WebSocketLike` (mirrors {@link createNodeWsController} in
 * `dig-node-ws.ts`). `src/background/index.ts` wires the real `WebSocket`, the §5.3 ladder resolver,
 * the paired-token getter, and broadcasts each {@link WalletSyncStatus} change to the popup.
 *
 * ADDITIVE: when the socket is not connected, {@link WalletControlWsController.request} rejects
 * immediately, so the SW's callers transparently fall back to the existing HTTP path — nothing
 * breaks if the node predates the `/ws` transport or the socket is momentarily down.
 */

import {
  type WebSocketLike,
  nextReconnectDelayMs,
  wsBaseFor,
  DEFAULT_BASE_RECONNECT_DELAY_MS,
  DEFAULT_MAX_RECONNECT_DELAY_MS,
  DEFAULT_STALE_AFTER_MS,
} from './dig-node-ws';

/** The controller's transport connection-state machine value. */
export type WalletWsConnState = 'connecting' | 'connected' | 'disconnected';

/** The wallet sync tri-state the node pushes (SPEC §4.8 `sync_status.state`). */
export type WalletSyncState = 'syncing' | 'synced' | 'disconnected';

/**
 * The wallet sync status the UI renders (#373). Derived from the node's pushed `sync_status` frame
 * while the socket is up; forced to `disconnected` (with null heights) the moment the socket drops —
 * a down socket is a disconnected wallet, never a stale "synced".
 */
export interface WalletSyncStatus {
  state: WalletSyncState;
  /** The wallet DB's synced peak height, or null until the node reports it. */
  peakHeight: number | null;
  /** The chain target height the wallet is syncing toward, or null when unknown. */
  targetHeight: number | null;
  /** `Date.now()`-shaped timestamp of the last transition/refresh. */
  updatedAt: number;
}

/** The frozen "socket never opened" status a fresh controller starts from. */
export function initialWalletSyncStatus(now: number = Date.now()): WalletSyncStatus {
  return { state: 'disconnected', peakHeight: null, targetHeight: null, updatedAt: now };
}

/** Map a dig-node base URL to its `/ws` wallet+control WebSocket URL (SPEC §4.8). */
export function walletWsUrlFor(base: string): string {
  return `${wsBaseFor(base)}/ws`;
}

/** A node→client frame (`response` | `sync_status` | `event`); any other `type` is ignored. */
interface WalletWsFrame {
  type?: string;
  id?: string | number;
  ok?: boolean;
  result?: unknown;
  error?: { code?: number; message?: string } | null;
  state?: string;
  peak_height?: number | null;
  target_height?: number | null;
  event?: unknown;
  [key: string]: unknown;
}

/** A rejected `request()` carries the node's coded error (or a transport code) for agent branching. */
export class WalletWsRequestError extends Error {
  constructor(
    message: string,
    /** The node's JSON-RPC numeric code, or a transport sentinel (see {@link WALLET_WS_ERR}). */
    readonly code: number,
  ) {
    super(message);
    this.name = 'WalletWsRequestError';
  }
}

/** Transport-level sentinel codes {@link WalletControlWsController.request} rejects with. */
export const WALLET_WS_ERR = Object.freeze({
  /** No socket is connected — the caller should fall back to HTTP. */
  NOT_CONNECTED: -33001,
  /** No `response` frame arrived within the timeout. */
  TIMEOUT: -33002,
  /** The socket closed with the request still in flight. */
  SOCKET_CLOSED: -33003,
});

/** How long a correlated request waits for its `response` frame before rejecting. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

export interface WalletWsControllerDeps {
  /** Resolve the current local dig-node base URL (the §5.3 ladder), or null if none is reachable. */
  resolveBase: () => Promise<string | null>;
  /** The paired control token to attach to gated ops, or null when not paired. Read per request. */
  getToken?: () => string | null | Promise<string | null>;
  /** Construct a socket for a `ws(s)://` URL. Defaults to the global `WebSocket`. */
  createSocket?: (url: string) => WebSocketLike;
  /** Called with a COPY of the sync status on every transition/refresh. */
  onSyncStatus?: (status: WalletSyncStatus) => void;
  /** Called with each pushed SyncEvent (`{ type:"coin_state" }`, …) so the SW can invalidate cache. */
  onEvent?: (event: unknown) => void;
  /** Called with the transport connection-state on every change. */
  onConnStateChange?: (state: WalletWsConnState) => void;
  now?: () => number;
  random?: () => number;
  scheduleTimeout?: (fn: () => void, ms: number) => unknown;
  clearScheduledTimeout?: (handle: unknown) => void;
  baseReconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  staleAfterMs?: number;
  requestTimeoutMs?: number;
}

/** A frame the controller sends — exposed for injection so a fake socket can capture what was sent. */
export interface SentRequestFrame {
  type: 'request';
  id: number;
  method: string;
  params: Record<string, unknown>;
  token?: string;
}

export interface WalletControlWsController {
  /** Begin the connect/reconnect loop. Idempotent. */
  start(): void;
  /** Stop the loop: close the socket, cancel timers, reject every in-flight request. */
  stop(): void;
  /** True when a socket is currently open (a `request()` will be sent, not rejected). */
  isConnected(): boolean;
  /** The current transport connection state. */
  getConnState(): WalletWsConnState;
  /** The current wallet sync status (what a fresh popup read hydrates from). */
  getSyncStatus(): WalletSyncStatus;
  /**
   * Issue one correlated wallet/control op over the socket. Resolves with the node's `result` on
   * `ok:true`; rejects with a {@link WalletWsRequestError} on `ok:false`, timeout, socket close, or
   * when not connected (code {@link WALLET_WS_ERR}.NOT_CONNECTED — the SW then falls back to HTTP).
   */
  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  /** Subscribe to sync-status changes; returns an unsubscribe function. */
  subscribeSyncStatus(listener: (status: WalletSyncStatus) => void): () => void;
}

/**
 * Create the dig-node `/ws` wallet+control controller (see the module doc for the wire + rationale).
 * Chrome-free — `src/background/index.ts` wires the real `WebSocket` + ladder resolver + paired-token
 * getter + a `chrome.runtime.sendMessage` broadcast on every sync-status change.
 */
export function createWalletControlWsController({
  resolveBase,
  getToken,
  createSocket = (url: string) => new WebSocket(url) as unknown as WebSocketLike,
  onSyncStatus,
  onEvent,
  onConnStateChange,
  now = () => Date.now(),
  random = Math.random,
  scheduleTimeout = (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearScheduledTimeout = (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  baseReconnectDelayMs = DEFAULT_BASE_RECONNECT_DELAY_MS,
  maxReconnectDelayMs = DEFAULT_MAX_RECONNECT_DELAY_MS,
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
}: WalletWsControllerDeps): WalletControlWsController {
  let connState: WalletWsConnState = 'disconnected';
  let syncStatus: WalletSyncStatus = initialWalletSyncStatus(now());
  const syncListeners = new Set<(status: WalletSyncStatus) => void>();
  let running = false;
  let attempt = 0;
  let socket: WebSocketLike | null = null;
  let reconnectHandle: unknown = null;
  let staleHandle: unknown = null;
  /** Invalidates stragglers from a superseded connect cycle (mirrors dig-node-ws). */
  let cycleId = 0;
  /** Monotonic request id → its pending promise settlers + timeout handle. */
  let nextRequestId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: WalletWsRequestError) => void; timer: unknown }>();

  function setConnState(next: WalletWsConnState): void {
    if (connState === next) return;
    connState = next;
    onConnStateChange?.(next);
  }

  function publishSync(patch: Partial<WalletSyncStatus>): void {
    syncStatus = { ...syncStatus, ...patch, updatedAt: now() };
    const snapshot = { ...syncStatus };
    for (const listener of syncListeners) listener(snapshot);
    onSyncStatus?.(snapshot);
  }

  /** Reject + drop every in-flight request (on close/stop) so no caller hangs forever. */
  function failAllPending(code: number, message: string): void {
    for (const [, entry] of pending) {
      clearScheduledTimeout(entry.timer);
      entry.reject(new WalletWsRequestError(message, code));
    }
    pending.clear();
  }

  function clearStaleTimer(): void {
    if (staleHandle != null) {
      clearScheduledTimeout(staleHandle);
      staleHandle = null;
    }
  }

  function armStaleTimer(myCycle: number): void {
    clearStaleTimer();
    staleHandle = scheduleTimeout(() => {
      if (myCycle !== cycleId) return;
      socket?.close();
    }, staleAfterMs);
  }

  function clearReconnectTimer(): void {
    if (reconnectHandle != null) {
      clearScheduledTimeout(reconnectHandle);
      reconnectHandle = null;
    }
  }

  function scheduleReconnect(myCycle: number): void {
    const delay = nextReconnectDelayMs(attempt, { baseMs: baseReconnectDelayMs, maxMs: maxReconnectDelayMs, random });
    attempt += 1;
    reconnectHandle = scheduleTimeout(() => {
      if (myCycle !== cycleId) return;
      void connectCycle();
    }, delay);
  }

  function handleFrame(frame: WalletWsFrame, myCycle: number): void {
    // Any frame proves the socket is alive — reset backoff + re-arm the staleness watchdog.
    attempt = 0;
    armStaleTimer(myCycle);

    if (frame.type === 'response' && frame.id != null) {
      const entry = pending.get(Number(frame.id));
      if (!entry) return; // unknown/duplicate id — ignore
      pending.delete(Number(frame.id));
      clearScheduledTimeout(entry.timer);
      if (frame.ok) {
        entry.resolve(frame.result);
      } else {
        const code = frame.error?.code ?? -32603;
        entry.reject(new WalletWsRequestError(frame.error?.message ?? 'wallet ws request failed', code));
      }
      return;
    }

    if (frame.type === 'sync_status') {
      const state: WalletSyncState =
        frame.state === 'synced' || frame.state === 'disconnected' ? frame.state : 'syncing';
      publishSync({
        state,
        peakHeight: typeof frame.peak_height === 'number' ? frame.peak_height : null,
        targetHeight: typeof frame.target_height === 'number' ? frame.target_height : null,
      });
      return;
    }

    if (frame.type === 'event') {
      onEvent?.(frame.event);
    }
  }

  async function connectCycle(): Promise<void> {
    const myCycle = cycleId;
    const base = await resolveBase().catch(() => null);
    if (myCycle !== cycleId || !running) return;

    if (!base) {
      setConnState('disconnected');
      publishSync({ state: 'disconnected', peakHeight: null, targetHeight: null });
      scheduleReconnect(myCycle);
      return;
    }

    setConnState('connecting');
    const s = createSocket(walletWsUrlFor(base));
    socket = s;

    s.onmessage = (ev: { data: unknown }) => {
      if (myCycle !== cycleId) return;
      if (connState !== 'connected') setConnState('connected');
      let frame: WalletWsFrame | null = null;
      try {
        frame = JSON.parse(String(ev.data)) as WalletWsFrame;
      } catch {
        return; // not JSON — ignore rather than tear down a live connection
      }
      handleFrame(frame, myCycle);
    };

    s.onclose = () => {
      if (myCycle !== cycleId) return;
      clearStaleTimer();
      socket = null;
      setConnState('disconnected');
      publishSync({ state: 'disconnected', peakHeight: null, targetHeight: null });
      failAllPending(WALLET_WS_ERR.SOCKET_CLOSED, 'wallet ws socket closed');
      if (running) scheduleReconnect(myCycle);
    };

    s.onerror = () => {
      // The browser also fires close on a connection failure; onclose does the transition.
    };
  }

  async function sendRequest<T>(method: string, params: Record<string, unknown>): Promise<T> {
    if (connState !== 'connected' || !socket) {
      throw new WalletWsRequestError('wallet ws not connected', WALLET_WS_ERR.NOT_CONNECTED);
    }
    const s = socket as WebSocketLike & { send?: (data: string) => void };
    if (typeof s.send !== 'function') {
      throw new WalletWsRequestError('wallet ws socket cannot send', WALLET_WS_ERR.NOT_CONNECTED);
    }
    const id = nextRequestId;
    nextRequestId += 1;
    const token = getToken ? (await getToken()) ?? undefined : undefined;
    const frame: SentRequestFrame = { type: 'request', id, method, params };
    if (token) frame.token = token;

    return await new Promise<T>((resolve, reject) => {
      const timer = scheduleTimeout(() => {
        pending.delete(id);
        reject(new WalletWsRequestError(`wallet ws request timed out (${method})`, WALLET_WS_ERR.TIMEOUT));
      }, requestTimeoutMs);
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        s.send!(JSON.stringify(frame));
      } catch (e) {
        pending.delete(id);
        clearScheduledTimeout(timer);
        reject(new WalletWsRequestError(e instanceof Error ? e.message : String(e), WALLET_WS_ERR.SOCKET_CLOSED));
      }
    });
  }

  return {
    start() {
      if (running) return;
      running = true;
      attempt = 0;
      void connectCycle();
    },
    stop() {
      running = false;
      cycleId += 1;
      clearReconnectTimer();
      clearStaleTimer();
      failAllPending(WALLET_WS_ERR.SOCKET_CLOSED, 'wallet ws controller stopped');
      socket?.close();
      socket = null;
      setConnState('disconnected');
    },
    isConnected() {
      return connState === 'connected';
    },
    getConnState() {
      return connState;
    },
    getSyncStatus() {
      return { ...syncStatus };
    },
    request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      return sendRequest<T>(method, params);
    },
    subscribeSyncStatus(listener: (status: WalletSyncStatus) => void) {
      syncListeners.add(listener);
      return () => syncListeners.delete(listener);
    },
  };
}
