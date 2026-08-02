/**
 * dig-node WS status/liveness controller (#239) — the SW's persistent connection to the local
 * dig-node's `GET /ws/status` endpoint (dig-node SPEC.md), giving the popup a LIVE connection
 * indicator instead of the old poll-on-open `getDigNodeStatus` probe.
 *
 * The dig-node WS endpoint sends a `status` snapshot on connect, then a `heartbeat` (a refreshed
 * snapshot + `ts`) every few seconds — the open socket itself is dig-node's liveness signal. This
 * module is the CLIENT half: a small state machine (`connecting` → `connected` → `disconnected` →
 * `connecting` …) that
 *   1. resolves the local dig-node base URL via the injected {@link NodeWsControllerDeps.resolveBase}
 *      (the SAME §5.3 ladder `resolveDigNode` already applies — this module does not re-implement it),
 *   2. opens a WebSocket at `<base>/ws/status`,
 *   3. reconnects with EXPONENTIAL BACKOFF + JITTER on any close/error, resetting the backoff the
 *      moment a connection succeeds again, and
 *   4. runs its OWN staleness watchdog: if no frame (snapshot/heartbeat) arrives within
 *      {@link DEFAULT_STALE_AFTER_MS}, the socket is force-closed and reconnected — this is the
 *      CLIENT-side half of "detect a half-open connection promptly" (dig-node's heartbeat ping is the
 *      server-side half; a browser's WebSocket API never surfaces raw ping/pong to page/SW JS, so the
 *      client must judge liveness from the APPLICATION-level messages it actually receives).
 *
 * Every dependency (the socket constructor, the clock, the RNG, the timer scheduler, the base
 * resolver) is injected — this file has NO chrome-API or DOM access, so the whole state machine is
 * unit-testable under vitest with a fake `WebSocketLike` and a fake scheduler (mirrors the
 * `createDigDnsAvailabilityController` idiom in `dig-dns.ts`). `src/background/index.ts` wires up
 * the real `WebSocket`, `resolveLocalDigNode`, and broadcasts every {@link NodeLiveStatus} change to
 * the popup (`nodeLiveStatusChanged`); the popup's `getLiveNodeStatus` RTK Query endpoint reads the
 * cached snapshot on mount and live-patches it from that broadcast (no polling for the live tier).
 *
 * The connect/reconnect/backoff/staleness state machine itself lives in the shared
 * {@link createWsReconnectLoop} (`ws-reconnect-core.ts`, #1466); this file is the `/ws/status`
 * PROTOCOL layer over it — the status-frame parsing + the {@link NodeLiveStatus} publish. The
 * primitives it historically defined (`WebSocketLike`, `nextReconnectDelayMs`, the `DEFAULT_*`
 * bounds) now live in the core and are RE-EXPORTED here so existing importers keep working.
 */

import {
  type WebSocketLike,
  type WsProtocol,
  type WsConnectionHandlers,
  type WsFrameContext,
  createWsReconnectLoop,
  nextReconnectDelayMs,
  DEFAULT_BASE_RECONNECT_DELAY_MS,
  DEFAULT_MAX_RECONNECT_DELAY_MS,
  DEFAULT_STALE_AFTER_MS,
} from './ws-reconnect-core';

export {
  type WebSocketLike,
  nextReconnectDelayMs,
  DEFAULT_BASE_RECONNECT_DELAY_MS,
  DEFAULT_MAX_RECONNECT_DELAY_MS,
  DEFAULT_STALE_AFTER_MS,
};

/** The controller's current connection-state machine value. */
export type NodeWsConnState = 'connecting' | 'connected' | 'disconnected';

/** The live status the popup renders — a superset of the old `{reachable, base}` probe result. */
export interface NodeLiveStatus {
  state: NodeWsConnState;
  /** The local dig-node base URL this status is/was for (e.g. `http://dig.local`), or null. */
  base: string | null;
  /** The node's reported bind `addr` (e.g. `127.0.0.1:9778`), or null until a snapshot arrives. */
  addr: string | null;
  /** The node's reported version, or null until a snapshot arrives. */
  version: string | null;
  /** The node's reported build commit, or null until a snapshot arrives. */
  commit: string | null;
  /** `Date.now()`-shaped timestamp of the last state transition or refreshed snapshot. */
  updatedAt: number;
}

/** The frozen "never connected" status a fresh controller starts from. */
export function initialNodeLiveStatus(now: number = Date.now()): NodeLiveStatus {
  return { state: 'disconnected', base: null, addr: null, version: null, commit: null, updatedAt: now };
}

/**
 * Convert a resolved dig-node base URL (`http://dig.local`, `http://localhost:9778`, an
 * explicit custom `http://host:port`) into its `/ws/status` WebSocket URL. Pure so the mapping
 * is unit-testable without a real socket. `https://` maps to `wss://`; a trailing slash on the
 * input is tolerated.
 */
export function wsUrlFor(base: string): string {
  return `${wsBaseFor(base)}/ws/status`;
}

/**
 * Convert a resolved dig-node base URL into its scheme-mapped WebSocket origin WITHOUT a path
 * (`http://dig.local/` → `ws://dig.local`, `https://x:9000` → `wss://x:9000`). Shared by both the
 * `/ws/status` liveness channel ({@link wsUrlFor}) and the `/ws` wallet+control transport
 * (`dig-node-wallet-ws.ts`), so the scheme/trailing-slash handling lives in exactly one place.
 */
export function wsBaseFor(base: string): string {
  const trimmed = base.replace(/\/+$/, '');
  return trimmed.replace(/^https:\/\//i, 'wss://').replace(/^http:\/\//i, 'ws://');
}

/** A parsed dig-node `/ws/status` frame (`status` or `heartbeat` — see dig-node SPEC.md). Any
 * other/unrecognized `type` (forward-compat with a future frame kind) is ignored, not an error. */
interface NodeWsFrame {
  type?: string;
  service?: string;
  version?: string;
  commit?: string;
  addr?: string;
  [key: string]: unknown;
}

export interface NodeWsControllerDeps {
  /** Resolve the current local dig-node base URL (the §5.3 ladder), or null if none is reachable. */
  resolveBase: () => Promise<string | null>;
  /** Construct a socket for a `ws(s)://` URL. Defaults to the global `WebSocket`. */
  createSocket?: (url: string) => WebSocketLike;
  /** Called with a COPY of the status on every transition/refresh. */
  onStatusChange?: (status: NodeLiveStatus) => void;
  now?: () => number;
  random?: () => number;
  /** Injectable timer scheduler (defaults to `setTimeout`/`clearTimeout`). */
  scheduleTimeout?: (fn: () => void, ms: number) => unknown;
  clearScheduledTimeout?: (handle: unknown) => void;
  baseReconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  /** See {@link DEFAULT_STALE_AFTER_MS}. */
  staleAfterMs?: number;
}

export interface NodeWsController {
  /** Begin the connect/reconnect loop. Idempotent — a second call while running is a no-op. */
  start(): void;
  /** Stop the loop: closes any open socket and cancels any pending reconnect/stale timer. */
  stop(): void;
  /** The current status, synchronously — what a fresh popup read hydrates from. */
  getStatus(): NodeLiveStatus;
  /** Subscribe to every status change; returns an unsubscribe function. */
  subscribe(listener: (status: NodeLiveStatus) => void): () => void;
}

/**
 * Create the dig-node WS status controller (see the module doc for the full state-machine
 * rationale). Chrome-free — `src/background/index.ts` wires the real `WebSocket` + ladder
 * resolver + a `chrome.runtime.sendMessage` broadcast on every {@link NodeLiveStatus} change.
 */
export function createNodeWsController({
  resolveBase,
  createSocket = (url: string) => new WebSocket(url) as unknown as WebSocketLike,
  onStatusChange,
  now = () => Date.now(),
  random = Math.random,
  scheduleTimeout = (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearScheduledTimeout = (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  baseReconnectDelayMs = DEFAULT_BASE_RECONNECT_DELAY_MS,
  maxReconnectDelayMs = DEFAULT_MAX_RECONNECT_DELAY_MS,
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
}: NodeWsControllerDeps): NodeWsController {
  let status: NodeLiveStatus = initialNodeLiveStatus(now());
  const listeners = new Set<(status: NodeLiveStatus) => void>();

  function publish(patch: Partial<NodeLiveStatus>): void {
    status = { ...status, ...patch, updatedAt: now() };
    const snapshot = { ...status };
    for (const listener of listeners) listener(snapshot);
    onStatusChange?.(snapshot);
  }

  /** The `/ws/status` protocol layer: parse status/heartbeat frames into {@link NodeLiveStatus}
   * publishes; the shared {@link createWsReconnectLoop} owns the connect/backoff/staleness loop. */
  const protocol: WsProtocol = {
    urlForBase: wsUrlFor,
    onNoBase() {
      publish({ state: 'disconnected', base: null, addr: null, version: null, commit: null });
    },
    connect(base: string): WsConnectionHandlers {
      publish({ state: 'connecting', base });
      return {
        onMessage(data: unknown, ctx: WsFrameContext) {
          let frame: NodeWsFrame | null = null;
          try {
            frame = JSON.parse(String(data)) as NodeWsFrame;
          } catch {
            return; // not a JSON frame — ignore rather than tear down a live connection
          }
          if (frame.type !== 'status' && frame.type !== 'heartbeat') return;
          ctx.markAlive(); // a real frame proves the connection is healthy — reset backoff + re-arm watchdog
          publish({
            state: 'connected',
            base,
            addr: frame.addr ?? status.addr,
            version: frame.version ?? status.version,
            commit: frame.commit ?? status.commit,
          });
        },
        onClose() {
          publish({ state: 'disconnected', addr: null, version: null, commit: null });
        },
      };
    },
  };

  const loop = createWsReconnectLoop({
    resolveBase,
    protocol,
    createSocket,
    now,
    random,
    scheduleTimeout,
    clearScheduledTimeout,
    baseReconnectDelayMs,
    maxReconnectDelayMs,
    staleAfterMs,
  });

  return {
    start() {
      loop.start();
    },
    stop() {
      loop.stop();
    },
    getStatus() {
      return { ...status };
    },
    subscribe(listener: (status: NodeLiveStatus) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
