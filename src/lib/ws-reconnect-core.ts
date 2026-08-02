/**
 * Shared WebSocket reconnect core (#1466) — the ONE implementation of the connect/reconnect loop
 * both dig-node WS controllers layer on top of: {@link createNodeWsController} (`dig-node-ws.ts`,
 * the `/ws/status` liveness channel) and {@link createWalletControlWsController}
 * (`dig-node-wallet-ws.ts`, the `/ws` wallet+control transport). Before this module both files
 * hand-implemented the SAME exponential-backoff + jitter + staleness-watchdog + cycle-guard state
 * machine (the wallet file's comments openly admitted it "mirrors createNodeWsController"); a drift
 * between the two copies would be a real reconnect-timing regression (thundering-herd / a dropped
 * connection that never comes back), so the timing math now lives in exactly one place.
 *
 * This core owns the parts that are IDENTICAL across endpoints:
 *   1. resolve the local dig-node base URL via the injected {@link WsProtocol.urlForBase} +
 *      the loop's `resolveBase` (the §5.3 ladder — this module never re-implements it),
 *   2. open a socket, wired so every browser event is CYCLE-GUARDED (a straggling handler from a
 *      superseded connect cycle can never mutate a newer cycle's state),
 *   3. reconnect with EXPONENTIAL BACKOFF + "equal jitter" on any close/error, resetting the
 *      backoff the moment the protocol layer reports a live frame (via {@link WsFrameContext.markAlive}),
 *   4. run the client-side STALENESS WATCHDOG: a `connected` socket that goes silent past
 *      {@link DEFAULT_STALE_AFTER_MS} is force-closed and reconnected (the client-side half of
 *      "detect a half-open connection promptly" — a browser WebSocket never surfaces raw ping/pong
 *      to page/SW JS, so liveness is judged from the APPLICATION frames actually received).
 *
 * Everything ENDPOINT-SPECIFIC — which URL, what to do when no node is reachable, the 'connecting'
 * publish, the per-frame protocol handling, the on-close cleanup, and any stop-time teardown — is
 * supplied by the {@link WsProtocol} the caller injects, so each controller stays a thin protocol
 * layer over this loop. Every side-effecting dependency (socket ctor, clock, RNG, timer scheduler,
 * base resolver) is injected, so the whole loop is unit-testable under vitest with a fake
 * `WebSocketLike` + fake scheduler — no chrome/DOM access.
 */

/** The subset of the browser `WebSocket` surface these controllers need — injectable so the whole
 * state machine is testable with a fake implementation (no real socket/DOM). */
export interface WebSocketLike {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  close(): void;
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

/** Passed to the protocol's per-frame handler so it can report liveness back to the loop. */
export interface WsFrameContext {
  /**
   * Report that a frame proving the connection is healthy just arrived: resets the reconnect
   * backoff to zero and (re)arms the staleness watchdog for the current connect cycle. The
   * protocol layer decides WHEN a frame counts as "alive" (e.g. only recognized frame types),
   * preserving each endpoint's exact behaviour.
   */
  markAlive(): void;
}

/** The per-connection handlers a {@link WsProtocol} returns from {@link WsProtocol.connect}, closing
 * over the resolved `base` for the duration of one socket's life. */
export interface WsConnectionHandlers {
  /** Handle one raw inbound frame payload (the `ev.data`); call {@link WsFrameContext.markAlive}
   * when the frame proves liveness. Cycle-guarded by the loop before it is ever invoked. */
  onMessage(data: unknown, ctx: WsFrameContext): void;
  /** The socket for THIS connection closed (loop already cleared the stale timer + nulled the
   * socket); do the endpoint's disconnect publish/cleanup. The loop schedules the reconnect after. */
  onClose(): void;
}

/** The endpoint-specific behaviour the reconnect loop drives — everything that differs between the
 * `/ws/status` liveness channel and the `/ws` wallet+control transport. */
export interface WsProtocol {
  /** Map a resolved dig-node base URL to this endpoint's `ws(s)://…` URL. */
  urlForBase(base: string): string;
  /** `resolveBase()` returned null (no local node reachable): publish the endpoint's disconnected
   * state. The loop schedules the retry. */
  onNoBase(): void;
  /** Begin connecting to `base`: do the 'connecting' publish and return the per-connection
   * handlers (which close over `base`). Called immediately BEFORE the socket is constructed,
   * matching each controller's original publish-then-open order. */
  connect(base: string): WsConnectionHandlers;
  /** Optional stop-time teardown (e.g. reject in-flight requests, reset conn state). Runs after the
   * socket is closed + nulled, with the cycle already invalidated. */
  onStop?(): void;
}

export interface WsReconnectLoopDeps {
  /** Resolve the current local dig-node base URL (the §5.3 ladder), or null if none is reachable. */
  resolveBase: () => Promise<string | null>;
  /** The endpoint-specific behaviour layered on the loop. */
  protocol: WsProtocol;
  /** Construct a socket for a `ws(s)://` URL. Defaults to the global `WebSocket`. */
  createSocket?: (url: string) => WebSocketLike;
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

/** The connect/reconnect loop a protocol controller drives. */
export interface WsReconnectLoop {
  /** Begin the connect/reconnect loop. Idempotent — a second call while running is a no-op. */
  start(): void;
  /** Stop the loop: close any open socket, cancel any pending reconnect/stale timer, run
   * {@link WsProtocol.onStop}. */
  stop(): void;
  /** The current socket, or null — the protocol layer needs it to send outbound frames. */
  getSocket(): WebSocketLike | null;
  /** Whether the loop is currently running (between {@link start} and {@link stop}). */
  isRunning(): boolean;
}

/**
 * Create the shared WebSocket reconnect loop (see the module doc for the state-machine rationale).
 * The returned loop owns the socket, the backoff, the staleness watchdog, and the cycle guard; the
 * injected {@link WsProtocol} supplies everything endpoint-specific.
 */
export function createWsReconnectLoop({
  resolveBase,
  protocol,
  createSocket = (url: string) => new WebSocket(url) as unknown as WebSocketLike,
  now = () => Date.now(),
  random = Math.random,
  scheduleTimeout = (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearScheduledTimeout = (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  baseReconnectDelayMs = DEFAULT_BASE_RECONNECT_DELAY_MS,
  maxReconnectDelayMs = DEFAULT_MAX_RECONNECT_DELAY_MS,
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
}: WsReconnectLoopDeps): WsReconnectLoop {
  void now; // reserved for parity with the controllers' injected clock; timers use the scheduler.
  let running = false;
  let attempt = 0;
  let socket: WebSocketLike | null = null;
  let reconnectHandle: unknown = null;
  let staleHandle: unknown = null;
  /** Bumped on every stop()/reconnect so a straggling async resolveBase() or socket event from a
   * PRIOR cycle can never apply its result after a newer cycle has already started. */
  let cycleId = 0;

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
      protocol.onNoBase();
      scheduleReconnect(myCycle);
      return;
    }

    const conn = protocol.connect(base);
    const s = createSocket(protocol.urlForBase(base));
    socket = s;
    const ctx: WsFrameContext = {
      markAlive() {
        attempt = 0; // a real frame proves the connection is healthy — reset backoff
        armStaleTimer(myCycle);
      },
    };

    s.onmessage = (ev: { data: unknown }) => {
      if (myCycle !== cycleId) return;
      conn.onMessage(ev.data, ctx);
    };

    s.onclose = () => {
      if (myCycle !== cycleId) return;
      clearStaleTimer();
      socket = null;
      conn.onClose();
      if (running) scheduleReconnect(myCycle);
    };

    s.onerror = () => {
      // The browser also fires a close event on a connection failure; onclose does the actual
      // state transition + reconnect scheduling. Nothing else to do here.
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
      cycleId += 1; // invalidate any in-flight resolveBase()/timers/socket events from the old cycle
      clearReconnectTimer();
      clearStaleTimer();
      socket?.close();
      socket = null;
      protocol.onStop?.();
    },
    getSocket() {
      return socket;
    },
    isRunning() {
      return running;
    },
  };
}
