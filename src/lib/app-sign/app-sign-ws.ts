/**
 * The APP-SIGN transport — the SW's WebSocket client to dig-app's paired identity/signing channel
 * (dig-app `SPEC.md §5.6.2`, `ws://127.0.0.1:9779`).
 *
 * This is a SECOND, independent channel from the extension↔dig-node CONTENT channel
 * (`dig-node-wallet-ws.ts`): that one carries `chia://` resolution + wallet reads; THIS one carries
 * identity/signing only (pair / connect / sign) and terminates at the dig-app tray process, which
 * holds the user key and raises the native confirm. Nothing here touches content resolution.
 *
 * # Wire (SPEC §5.6.2) — JSON-RPC 2.0 text frames, one message per WS message
 *   client→app: `{ jsonrpc:"2.0", id, method, params, auth? }`   (`auth` on every post-pairing frame)
 *   app→client: `{ jsonrpc:"2.0", id, result }`  |  `{ jsonrpc:"2.0", id, error:{ code, message, data } }`
 *
 * The symbolic error taxonomy (§5.6.7 — `AUTH_BAD_MAC`, `SIGN_DENIED`, …) is carried in the
 * JSON-RPC `error.data` field as the stable UPPER_SNAKE string; the numeric `error.code` is
 * advisory. The controller extracts that symbolic code and rejects with an {@link AppSignError} so
 * callers branch on the code, never on prose (§6.2). (`error.data` is the agreed contract slot for
 * the symbolic code — see the SIGN-4 report; dig-app SIGN-1/2/3 MUST match.)
 *
 * Transport model vs. the node channel: dig-node has an HTTP fallback, so its WS rejects a
 * not-connected request and the caller retries over HTTP. dig-app has NO fallback path — the
 * identity endpoint is WS-only — so a not-connected/refused socket means "dig-app is not running",
 * surfaced to the caller as `APP_NOT_RUNNING` (the relay turns that into a launch/install deep-link,
 * §5.6.2). The controller still auto-reconnects with backoff so it recovers the moment dig-app
 * starts.
 *
 * CHROME-FREE + DOM-free: every dependency is injected (socket ctor, clock, RNG, timer scheduler),
 * so the whole state machine + correlation logic is unit-testable with a fake `WebSocketLike`
 * (mirrors `createNodeWsController` / `createWalletControlWsController`). `src/background/index.ts`
 * wires the real `WebSocket`.
 */

import {
  type WebSocketLike,
  nextReconnectDelayMs,
  DEFAULT_BASE_RECONNECT_DELAY_MS,
  DEFAULT_MAX_RECONNECT_DELAY_MS,
  DEFAULT_STALE_AFTER_MS,
} from '../dig-node-ws';
import { AppSignError, isServerCode, type AppSignCode } from './errors';
import type { AuthObject } from './auth-frame';

/** The controller's transport connection-state machine value. */
export type AppSignConnState = 'connecting' | 'connected' | 'disconnected';

/** The canonical dig-app identity loopback endpoint (SPEC §5.6.2; recorded in the `canonical` skill). */
export const DEFAULT_APP_SIGN_WS_URL = 'ws://127.0.0.1:9779';

/** A JSON-RPC 2.0 request frame the controller sends (`auth` present on every post-pairing frame). */
export interface AppSignRequestFrame {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: Record<string, unknown>;
  auth?: AuthObject;
}

/** A parsed app→client frame; anything not shaped like a JSON-RPC response is ignored. */
interface AppSignResponseFrame {
  jsonrpc?: string;
  id?: string | number;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown } | null;
}

/** How long a correlated request waits for its response before rejecting `TRANSPORT_TIMEOUT`. */
export const DEFAULT_APP_SIGN_TIMEOUT_MS = 120_000;

/**
 * The default request timeout is deliberately LONG (2 min): a `sign.request`/`connect.request`
 * blocks on a human at the OS-native biometric confirm, which legitimately takes many seconds. A
 * short timeout would abort a request the user is about to approve.
 */

export interface AppSignControllerDeps {
  /** The WS URL to connect to. Defaults to {@link DEFAULT_APP_SIGN_WS_URL}. */
  url?: string;
  /** Construct a socket for a `ws://` URL. Defaults to the global `WebSocket`. */
  createSocket?: (url: string) => WebSocketLike;
  /** Called with the transport connection-state on every change. */
  onConnStateChange?: (state: AppSignConnState) => void;
  random?: () => number;
  scheduleTimeout?: (fn: () => void, ms: number) => unknown;
  clearScheduledTimeout?: (handle: unknown) => void;
  baseReconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  staleAfterMs?: number;
  requestTimeoutMs?: number;
}

export interface AppSignController {
  /** Begin the connect/reconnect loop. Idempotent. */
  start(): void;
  /** Stop the loop: close the socket, cancel timers, reject every in-flight request. */
  stop(): void;
  /** True when a socket is currently open. */
  isConnected(): boolean;
  /** The current transport connection state. */
  getConnState(): AppSignConnState;
  /**
   * Issue one JSON-RPC 2.0 request over the channel, attaching `auth` when supplied. Resolves with
   * the `result` on success; rejects with an {@link AppSignError} carrying the §5.6.7 symbolic code
   * (or a transport code: `APP_NOT_RUNNING` when the socket is down, `TRANSPORT_TIMEOUT`,
   * `TRANSPORT_CLOSED`, `BAD_RESPONSE`).
   */
  request<T = unknown>(method: string, params?: Record<string, unknown>, auth?: AuthObject): Promise<T>;
  /** Subscribe to connection-state changes; returns an unsubscribe function. */
  subscribe(listener: (state: AppSignConnState) => void): () => void;
}

/** Extract the §5.6.7 symbolic code from a JSON-RPC error, falling back to `BAD_RESPONSE`. */
function symbolicCodeFor(error: { message?: string; data?: unknown } | null | undefined): AppSignCode {
  const data = error?.data;
  if (typeof data === 'string' && isServerCode(data)) return data;
  if (typeof data === 'object' && data !== null) {
    const inner = (data as Record<string, unknown>).code;
    if (typeof inner === 'string' && isServerCode(inner)) return inner;
  }
  return 'BAD_RESPONSE';
}

/**
 * Create the APP-SIGN WS controller (see the module doc for the wire + rationale). Chrome-free —
 * the SW wires the real `WebSocket`.
 */
export function createAppSignController({
  url = DEFAULT_APP_SIGN_WS_URL,
  createSocket = (u: string) => new WebSocket(u) as unknown as WebSocketLike,
  onConnStateChange,
  random = Math.random,
  scheduleTimeout = (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearScheduledTimeout = (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  baseReconnectDelayMs = DEFAULT_BASE_RECONNECT_DELAY_MS,
  maxReconnectDelayMs = DEFAULT_MAX_RECONNECT_DELAY_MS,
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
  requestTimeoutMs = DEFAULT_APP_SIGN_TIMEOUT_MS,
}: AppSignControllerDeps = {}): AppSignController {
  let connState: AppSignConnState = 'disconnected';
  const listeners = new Set<(state: AppSignConnState) => void>();
  let running = false;
  let attempt = 0;
  let socket: WebSocketLike | null = null;
  let reconnectHandle: unknown = null;
  let staleHandle: unknown = null;
  let cycleId = 0;
  let nextRequestId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: AppSignError) => void; timer: unknown }>();

  function setConnState(next: AppSignConnState): void {
    if (connState === next) return;
    connState = next;
    const snapshot = next;
    for (const listener of listeners) listener(snapshot);
    onConnStateChange?.(snapshot);
  }

  /** Reject + drop every in-flight request (on close/stop) so no caller hangs forever. */
  function failAllPending(code: AppSignCode, message: string): void {
    for (const [, entry] of pending) {
      clearScheduledTimeout(entry.timer);
      entry.reject(new AppSignError(code, message));
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

  function handleFrame(frame: AppSignResponseFrame, myCycle: number): void {
    // Any frame proves the socket is alive — reset backoff + re-arm the staleness watchdog.
    attempt = 0;
    armStaleTimer(myCycle);

    if (frame.id == null) return; // a notification / non-correlated frame — nothing to settle
    const entry = pending.get(Number(frame.id));
    if (!entry) return; // unknown/duplicate id — ignore
    pending.delete(Number(frame.id));
    clearScheduledTimeout(entry.timer);

    if (frame.error) {
      const code = symbolicCodeFor(frame.error);
      entry.reject(new AppSignError(code, frame.error.message ?? code));
    } else {
      entry.resolve(frame.result);
    }
  }

  function connectCycle(): void {
    const myCycle = cycleId;
    if (!running) return;

    setConnState('connecting');
    const s = createSocket(url);
    socket = s;

    s.onopen = () => {
      if (myCycle !== cycleId) return;
      attempt = 0;
      setConnState('connected');
      armStaleTimer(myCycle);
    };

    s.onmessage = (ev: { data: unknown }) => {
      if (myCycle !== cycleId) return;
      if (connState !== 'connected') setConnState('connected');
      let frame: AppSignResponseFrame | null = null;
      try {
        frame = JSON.parse(String(ev.data)) as AppSignResponseFrame;
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
      // A close with requests still in flight (incl. a close BEFORE open = connection refused =
      // dig-app not running) fails them as TRANSPORT_CLOSED; the relay maps a down channel to
      // APP_NOT_RUNNING for a fresh request.
      failAllPending('TRANSPORT_CLOSED', 'app-sign socket closed');
      if (running) scheduleReconnect(myCycle);
    };

    s.onerror = () => {
      // The browser fires close on a connection failure too; onclose does the transition.
    };
  }

  function sendRequest<T>(method: string, params: Record<string, unknown>, auth?: AuthObject): Promise<T> {
    if (connState !== 'connected' || !socket) {
      // No open socket = dig-app unreachable/not running (no HTTP fallback exists for this channel).
      return Promise.reject(new AppSignError('APP_NOT_RUNNING', 'dig-app identity channel is not connected'));
    }
    const s = socket as WebSocketLike & { send?: (data: string) => void };
    if (typeof s.send !== 'function') {
      return Promise.reject(new AppSignError('APP_NOT_RUNNING', 'app-sign socket cannot send'));
    }
    const id = nextRequestId;
    nextRequestId += 1;
    const frame: AppSignRequestFrame = { jsonrpc: '2.0', id, method, params };
    if (auth) frame.auth = auth;

    return new Promise<T>((resolve, reject) => {
      const timer = scheduleTimeout(() => {
        pending.delete(id);
        reject(new AppSignError('TRANSPORT_TIMEOUT', `app-sign request timed out (${method})`));
      }, requestTimeoutMs);
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        s.send!(JSON.stringify(frame));
      } catch (e) {
        pending.delete(id);
        clearScheduledTimeout(timer);
        reject(new AppSignError('TRANSPORT_CLOSED', e instanceof Error ? e.message : String(e)));
      }
    });
  }

  return {
    start() {
      if (running) return;
      running = true;
      attempt = 0;
      connectCycle();
    },
    stop() {
      running = false;
      cycleId += 1;
      clearReconnectTimer();
      clearStaleTimer();
      failAllPending('TRANSPORT_CLOSED', 'app-sign controller stopped');
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
    request<T = unknown>(method: string, params: Record<string, unknown> = {}, auth?: AuthObject): Promise<T> {
      return sendRequest<T>(method, params, auth);
    },
    subscribe(listener: (state: AppSignConnState) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
