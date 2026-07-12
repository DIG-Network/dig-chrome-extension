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
 */

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

/** Default exponential-backoff bounds (ms) — see {@link nextReconnectDelayMs}. */
export const DEFAULT_BASE_RECONNECT_DELAY_MS = 1_000;
export const DEFAULT_MAX_RECONNECT_DELAY_MS = 30_000;

/**
 * Exponential backoff with "equal jitter" (half fixed, half random) for the given zero-based
 * attempt number: `min(maxMs, baseMs * 2^attempt)`, half of it fixed and half uniformly random —
 * avoids a reconnect thundering-herd while still bounding the worst-case wait. `random` is
 * injectable (defaults to `Math.random`) so a test can assert the exact min/max bounds
 * deterministically (`random: () => 0` / `() => 1`).
 */
export function nextReconnectDelayMs(
  attempt: number,
  {
    baseMs = DEFAULT_BASE_RECONNECT_DELAY_MS,
    maxMs = DEFAULT_MAX_RECONNECT_DELAY_MS,
    random = Math.random,
  }: { baseMs?: number; maxMs?: number; random?: () => number } = {},
): number {
  const exp = Math.min(maxMs, baseMs * Math.pow(2, Math.max(0, attempt)));
  const fixed = exp / 2;
  return Math.round(fixed + random() * fixed);
}

/** How long a `connected` socket may go without ANY frame before it's treated as half-open and
 * force-reconnected (client-side half of "detect a half-open connection promptly", #239). Well
 * above dig-node's own ~5s heartbeat interval so ordinary scheduling jitter never trips it. */
export const DEFAULT_STALE_AFTER_MS = 20_000;

/** The subset of the browser `WebSocket` surface this controller needs — injectable so the whole
 * state machine is testable with a fake implementation (no real socket/DOM). */
export interface WebSocketLike {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  close(): void;
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
  let running = false;
  let attempt = 0;
  let socket: WebSocketLike | null = null;
  let reconnectHandle: unknown = null;
  let staleHandle: unknown = null;
  /** Bumped on every stop()/reconnect so a straggling async resolveBase() from a PRIOR cycle can
   * never apply its result after a newer cycle has already started (avoids a stale-base race). */
  let cycleId = 0;

  function publish(patch: Partial<NodeLiveStatus>): void {
    status = { ...status, ...patch, updatedAt: now() };
    const snapshot = { ...status };
    for (const listener of listeners) listener(snapshot);
    onStatusChange?.(snapshot);
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
      // No frame within staleAfterMs while nominally connected: treat as half-open.
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

  async function connectCycle(): Promise<void> {
    const myCycle = cycleId;
    const base = await resolveBase().catch(() => null);
    if (myCycle !== cycleId || !running) return; // stopped/superseded while resolving

    if (!base) {
      publish({ state: 'disconnected', base: null, addr: null, version: null, commit: null });
      scheduleReconnect(myCycle);
      return;
    }

    publish({ state: 'connecting', base });
    const s = createSocket(wsUrlFor(base));
    socket = s;

    s.onmessage = (ev: { data: unknown }) => {
      if (myCycle !== cycleId) return;
      let frame: NodeWsFrame | null = null;
      try {
        frame = JSON.parse(String(ev.data)) as NodeWsFrame;
      } catch {
        return; // not a JSON frame — ignore rather than tear down a live connection
      }
      if (frame.type !== 'status' && frame.type !== 'heartbeat') return;
      attempt = 0; // a real frame proves the connection is healthy — reset backoff
      armStaleTimer(myCycle);
      publish({
        state: 'connected',
        base,
        addr: frame.addr ?? status.addr,
        version: frame.version ?? status.version,
        commit: frame.commit ?? status.commit,
      });
    };

    s.onclose = () => {
      if (myCycle !== cycleId) return;
      clearStaleTimer();
      socket = null;
      publish({ state: 'disconnected', addr: null, version: null, commit: null });
      if (running) scheduleReconnect(myCycle);
    };

    s.onerror = () => {
      // The browser also fires a close event on a connection failure; onclose does the
      // actual state transition + reconnect scheduling. Nothing else to do here.
    };
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
      cycleId += 1; // invalidate any in-flight resolveBase()/timers from the old cycle
      clearReconnectTimer();
      clearStaleTimer();
      socket?.close();
      socket = null;
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
