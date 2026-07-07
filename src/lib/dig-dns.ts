/**
 * dig-dns Path-B proxy fallback (#175, Component C of #174) — self-healing `.dig` resolution.
 *
 * dig-dns (`modules/apps/dig-dns`, installed as an OS service by dig-installer) gives the machine
 * `*.dig` name resolution through TWO independent paths, either of which alone makes a `.dig` URL
 * load (dig-dns SPEC.md §3):
 *
 *   - **Path A — OS split-DNS.** The OS resolves `.dig` → `127.0.0.5`; the browser makes an
 *     ordinary origin-form request to the gateway. This can be silently defeated by DNS-over-HTTPS,
 *     Chrome's built-in resolver, or a `:80` conflict on the machine.
 *   - **Path B — PAC proxy.** A PAC file served at `/.dig/proxy.pac` routes `*.dig` to the gateway
 *     as an HTTP **proxy** instead — the gateway handles the absolute-form proxy request directly,
 *     needing NO DNS at all. `chrome.proxy` with `mode:'pac_script'` engages this from the browser
 *     side.
 *
 * This module is the EXTENSION half of Path B: a small state machine that (1) detects whether
 * dig-dns is running at all (the loopback control endpoints, SPEC.md §4.7 — `/.dig/resolve-probe`
 * for liveness, `/.dig/health` for the actually-bound gateway port, since `:80` can fall back to
 * `:8053`), (2) engages the PAC proxy the moment a REAL `.dig` navigation fails (Path A broken in
 * practice), and (3) self-heals: once dig-dns has answered healthily for
 * {@link DIG_DNS_RECOVERY_PROBE_THRESHOLD} consecutive probes with no further navigation error in
 * between, it removes the proxy and lets Path A prove itself again (re-engaging immediately if it
 * is still actually broken).
 *
 * Every dependency (fetch, `chrome.proxy`, the clock) is injected — this file has NO chrome.* or
 * DOM access, so the whole state machine is unit-testable under vitest. The module SW
 * (src/background/index.ts) wires up the REAL `chrome.proxy.settings`, calls {@link
 * DigDnsAvailabilityController.probe} on startup + a `chrome.alarms` interval, and calls {@link
 * DigDnsAvailabilityController.reportNavigationError} from its `webNavigation.onErrorOccurred`
 * listener for `.dig`-TLD hosts. The SAME controller instance backs the `getDigDnsStatus` message
 * action (src/lib/messages.ts) — the ONE shared availability signal every feature reads (the
 * Resolver tab's indicator here, and #172's open-by-URN dig-dns-detect branch), so nothing
 * per-feature re-probes dig-dns on its own.
 *
 * On uninstall/disable, Chrome itself reverts any `chrome.proxy.settings` an extension applied
 * (an extension-controlled `ChromeSetting` is discarded the moment the controlling extension is
 * unloaded) — so no explicit uninstall hook is needed here; {@link
 * DigDnsAvailabilityController.dispose} exists for an explicit/graceful teardown (tests, a future
 * "turn off proxy fallback" settings control).
 */

/** The dig-dns loopback IP every path binds to (dig-dns SPEC.md §2 default; never a public address). */
export const DIG_DNS_LOOPBACK_IP = '127.0.0.5';

/**
 * The HTTP gateway's candidate ports, in the SAME deterministic order dig-dns itself falls back
 * (SPEC.md §4): `:80` first, `:8053` when `:80` is held (e.g. by `http.sys`). The actually-bound
 * port is confirmed via `/.dig/health`'s `bound_port` field, not assumed from which one answered.
 */
export const DIG_DNS_GATEWAY_PORTS: readonly number[] = Object.freeze([80, 8053]);

/**
 * Consecutive healthy probes (with no `reportNavigationError` in between) required before the
 * controller optimistically removes an engaged PAC proxy and lets Path A (OS split-DNS) prove
 * itself again. A single healthy probe only proves dig-dns's gateway is alive — not that the OS
 * actually routes `.dig` there — so recovery is gated on a short SUSTAINED window rather than one
 * probe, while still self-healing without user action.
 */
export const DIG_DNS_RECOVERY_PROBE_THRESHOLD = 3;

/** Default per-request probe timeout (ms) — the gateway is loopback-local; this stays tight. */
const DEFAULT_PROBE_TIMEOUT_MS = 1500;

/**
 * How stale a snapshot may be before `getDigDnsStatus` triggers a fresh probe instead of serving
 * the cached one (the `chrome.alarms` interval alone would leave a reader up to 2 minutes stale
 * when no probe has happened recently — e.g. right after dig-dns was just installed/started).
 * Short enough that a UI polling this action (the Resolver tab indicator, #172) sees a prompt
 * update; long enough that rapid successive reads don't re-probe the loopback gateway needlessly.
 */
export const DIG_DNS_STATUS_REFRESH_MS = 5_000;

/**
 * True when a `getDigDnsStatus` read should trigger {@link DigDnsAvailabilityController.probe}
 * rather than serve the cached snapshot — no prior probe, or the last one is older than
 * `refreshMs`. Pure so the throttle decision is unit-testable without a clock/timer.
 */
export function shouldRefreshDigDnsSnapshot(
  snapshot: Pick<DigDnsSnapshot, 'lastProbeAt'> | null | undefined,
  now: number,
  refreshMs: number = DIG_DNS_STATUS_REFRESH_MS,
): boolean {
  if (!snapshot || snapshot.lastProbeAt == null) return true;
  return now - snapshot.lastProbeAt > refreshMs;
}

/** The `/.dig/health` JSON payload (dig-dns SPEC.md §4.7) — only the fields this module reads. */
export interface DigDnsHealth {
  status?: string;
  version?: string;
  bound_port?: number;
  loopback_ip?: string;
  tld?: string;
  node?: unknown;
  paths?: { dns?: boolean; gateway?: boolean };
  [key: string]: unknown;
}

/** The outcome of one {@link probeDigDns} sweep across the candidate ports. */
export interface DigDnsProbeResult {
  /** Did ANY candidate port answer the resolve-probe liveness check? */
  available: boolean;
  /** The actually-bound gateway port (from `/.dig/health`, or the answering port if health failed), or null. */
  boundPort: number | null;
  /** The parsed `/.dig/health` payload, or null if unavailable/unreachable/unparsable. */
  health: DigDnsHealth | null;
}

/** The Path-B lifecycle phase (mirrors `docs.dig.net`'s local-resolution troubleshooting states). */
export type DigDnsPhase =
  | 'unknown' // not probed yet (fresh SW / fresh controller)
  | 'direct' // dig-dns is reachable; Path A is assumed to be working; no proxy engaged
  | 'proxy' // dig-dns is reachable but a `.dig` navigation errored; the PAC proxy is engaged
  | 'unavailable'; // dig-dns is not reachable at all (not installed / not running)

/** The shared availability signal every feature (Resolver tab indicator, #172) reads. */
export interface DigDnsSnapshot {
  phase: DigDnsPhase;
  boundPort: number | null;
  /** The `/.dig/proxy.pac` URL for the current bound port, or null before any successful probe. */
  pacUrl: string | null;
  loopbackIp: string;
  /** `true` iff `phase === 'proxy'` (the PAC proxy is currently engaged) — the UI's headline bit. */
  proxyActive: boolean;
  lastProbeAt: number | null;
  lastError: string | null;
}

/** Build the `/.dig/proxy.pac` URL dig-dns serves for the given bound port. */
export function buildDigDnsPacUrl(loopbackIp: string, port: number): string {
  return `http://${loopbackIp}:${port}/.dig/proxy.pac`;
}

/** The `chrome.proxy.settings.set()` config shape that engages the dig-dns PAC (regular profile only). */
export interface DigDnsProxyConfig {
  value: { mode: 'pac_script'; pacScript: { url: string } };
  scope: 'regular';
}

/** Build the `chrome.proxy.settings.set()` argument that engages Path B for `pacUrl`. */
export function buildDigDnsProxyConfig(pacUrl: string): DigDnsProxyConfig {
  return { value: { mode: 'pac_script', pacScript: { url: pacUrl } }, scope: 'regular' };
}

/** Fetch `path` on `loopbackIp:port` with an injectable fetch + a hard timeout; null on any failure. */
async function fetchLoopback(
  loopbackIp: string,
  port: number,
  path: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<Response | null> {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    return await fetchImpl(`http://${loopbackIp}:${port}${path}`, {
      method: 'GET',
      signal: ctrl ? ctrl.signal : undefined,
    });
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Probe dig-dns's HTTP gateway directly at the loopback IP (no `.dig` hostname / DNS involved —
 * this is a liveness + port-discovery check, distinct from whether the OS actually routes `.dig`
 * names there). Tries {@link DIG_DNS_GATEWAY_PORTS} in order; the FIRST port whose
 * `/.dig/resolve-probe` answers `204` wins, and `/.dig/health` is then fetched on that same port
 * to confirm the authoritative bound port + read the full status payload (best-effort — a failed
 * health fetch still counts as "available" since resolve-probe already proved reachability).
 */
export async function probeDigDns({
  fetchImpl = fetch,
  loopbackIp = DIG_DNS_LOOPBACK_IP,
  ports = DIG_DNS_GATEWAY_PORTS,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
}: {
  fetchImpl?: typeof fetch;
  loopbackIp?: string;
  ports?: readonly number[];
  timeoutMs?: number;
} = {}): Promise<DigDnsProbeResult> {
  for (const port of ports) {
    const probeResp = await fetchLoopback(loopbackIp, port, '/.dig/resolve-probe', fetchImpl, timeoutMs);
    if (!probeResp || probeResp.status !== 204) continue;

    let health: DigDnsHealth | null = null;
    const healthResp = await fetchLoopback(loopbackIp, port, '/.dig/health', fetchImpl, timeoutMs);
    if (healthResp && healthResp.ok) {
      try {
        health = (await healthResp.json()) as DigDnsHealth;
      } catch {
        health = null;
      }
    }

    const boundPort = typeof health?.bound_port === 'number' ? health.bound_port : port;
    return { available: true, boundPort, health };
  }
  return { available: false, boundPort: null, health: null };
}

/**
 * `webNavigation` `net::` error codes that mean "this navigation could not even reach a host"
 * (DNS/connect-class failures) — as opposed to the host answering with an HTTP error, which is
 * not a Path-A (OS split-DNS) problem and must not trigger the proxy fallback.
 */
const DOT_DIG_FAILURE_ERROR_CODES: ReadonlySet<string> = new Set([
  'net::ERR_NAME_NOT_RESOLVED',
  'net::ERR_NAME_RESOLUTION_FAILED',
  'net::ERR_CONNECTION_REFUSED',
  'net::ERR_CONNECTION_TIMED_OUT',
  'net::ERR_ADDRESS_UNREACHABLE',
  'net::ERR_TIMED_OUT',
]);

/**
 * True when a `chrome.webNavigation.onErrorOccurred` event means "a real `.dig` navigation could
 * not reach its host" — the practical signal that Path A isn't routing `.dig` names to dig-dns
 * right now, and the trigger for {@link DigDnsAvailabilityController.reportNavigationError}.
 * Scoped to the top-level frame (`frameId === 0`, matching how the extension already gates its
 * other `dig.local`/`chia://` `onErrorOccurred` branches) and DNS/connect-class errors only.
 */
export function isDotDigNavigationFailure({
  url,
  error,
  frameId,
}: {
  url?: string;
  error?: string;
  frameId?: number;
}): boolean {
  if (frameId !== 0) return false;
  if (!error || !DOT_DIG_FAILURE_ERROR_CODES.has(error)) return false;
  if (!url) return false;
  try {
    return new URL(url).hostname.toLowerCase().endsWith('.dig');
  } catch {
    return false;
  }
}

/** A minimal `chrome.proxy.settings`-shaped interface, injected so this module never touches `chrome.*`. */
export interface ChromeProxyLike {
  set(config: DigDnsProxyConfig): Promise<void> | void;
  clear(config: { scope: 'regular' }): Promise<void> | void;
}

export interface DigDnsAvailabilityControllerDeps {
  /** The (only) required dependency — how the controller engages/disengages Path B. */
  chromeProxy: ChromeProxyLike;
  fetchImpl?: typeof fetch;
  loopbackIp?: string;
  ports?: readonly number[];
  timeoutMs?: number;
  /** See {@link DIG_DNS_RECOVERY_PROBE_THRESHOLD}. */
  recoveryThreshold?: number;
  /** Injectable clock (defaults to `Date.now`) for deterministic `lastProbeAt` in tests. */
  now?: () => number;
}

export interface DigDnsAvailabilityController {
  /** Re-probe dig-dns; on failure/success drives the `unavailable`/`direct`/self-heal transitions. */
  probe(): Promise<DigDnsSnapshot>;
  /** A real `.dig` navigation just failed: re-probe and engage the PAC proxy if dig-dns is reachable. */
  reportNavigationError(): Promise<DigDnsSnapshot>;
  /** The current signal, synchronously — what `getDigDnsStatus` and #172 read. */
  getSnapshot(): DigDnsSnapshot;
  /** Subscribe to every state change; returns an unsubscribe function. */
  subscribe(listener: (snapshot: DigDnsSnapshot) => void): () => void;
  /** Explicit teardown: clears an engaged proxy (safe/no-op if none is engaged). */
  dispose(): Promise<void>;
}

/** The frozen initial signal — no probe has run yet. */
function initialSnapshot(loopbackIp: string): DigDnsSnapshot {
  return {
    phase: 'unknown',
    boundPort: null,
    pacUrl: null,
    loopbackIp,
    proxyActive: false,
    lastProbeAt: null,
    lastError: null,
  };
}

/**
 * Create the dig-dns Path-B availability controller — the ONE shared signal + engage/disengage
 * decision layer (see the module doc for the full state-machine rationale).
 */
export function createDigDnsAvailabilityController({
  chromeProxy,
  fetchImpl = fetch,
  loopbackIp = DIG_DNS_LOOPBACK_IP,
  ports = DIG_DNS_GATEWAY_PORTS,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  recoveryThreshold = DIG_DNS_RECOVERY_PROBE_THRESHOLD,
  now = () => Date.now(),
}: DigDnsAvailabilityControllerDeps): DigDnsAvailabilityController {
  let snapshot = initialSnapshot(loopbackIp);
  /** Consecutive healthy probes since the proxy was engaged (or since the last nav error). */
  let healthyStreak = 0;
  const listeners = new Set<(snapshot: DigDnsSnapshot) => void>();

  function publish(next: DigDnsSnapshot): DigDnsSnapshot {
    snapshot = next;
    for (const listener of listeners) listener({ ...snapshot });
    return { ...snapshot };
  }

  async function engageProxy(pacUrl: string): Promise<void> {
    await chromeProxy.set(buildDigDnsProxyConfig(pacUrl));
  }

  async function disengageProxy(): Promise<void> {
    await chromeProxy.clear({ scope: 'regular' });
  }

  async function probe(): Promise<DigDnsSnapshot> {
    const result = await probeDigDns({ fetchImpl, loopbackIp, ports, timeoutMs });
    const lastProbeAt = now();

    if (!result.available) {
      if (snapshot.phase === 'proxy') await disengageProxy();
      healthyStreak = 0;
      return publish({
        phase: 'unavailable',
        boundPort: null,
        pacUrl: null,
        loopbackIp,
        proxyActive: false,
        lastProbeAt,
        lastError: 'dig-dns unreachable at ' + loopbackIp,
      });
    }

    const pacUrl = buildDigDnsPacUrl(loopbackIp, result.boundPort as number);

    if (snapshot.phase === 'proxy') {
      healthyStreak += 1;
      if (healthyStreak >= recoveryThreshold) {
        await disengageProxy();
        healthyStreak = 0;
        return publish({
          phase: 'direct',
          boundPort: result.boundPort,
          pacUrl,
          loopbackIp,
          proxyActive: false,
          lastProbeAt,
          lastError: null,
        });
      }
      // Still recovering — keep the proxy engaged and refresh the PAC target in case the bound
      // port changed (e.g. dig-dns restarted and fell back from :80 to :8053).
      if (pacUrl !== snapshot.pacUrl) await engageProxy(pacUrl);
      return publish({
        phase: 'proxy',
        boundPort: result.boundPort,
        pacUrl,
        loopbackIp,
        proxyActive: true,
        lastProbeAt,
        lastError: null,
      });
    }

    healthyStreak = 0;
    return publish({
      phase: 'direct',
      boundPort: result.boundPort,
      pacUrl,
      loopbackIp,
      proxyActive: false,
      lastProbeAt,
      lastError: null,
    });
  }

  async function reportNavigationError(): Promise<DigDnsSnapshot> {
    const result = await probeDigDns({ fetchImpl, loopbackIp, ports, timeoutMs });
    const lastProbeAt = now();

    if (!result.available) {
      if (snapshot.phase === 'proxy') await disengageProxy();
      healthyStreak = 0;
      return publish({
        phase: 'unavailable',
        boundPort: null,
        pacUrl: null,
        loopbackIp,
        proxyActive: false,
        lastProbeAt,
        lastError: 'a .dig navigation failed and dig-dns is unreachable',
      });
    }

    const pacUrl = buildDigDnsPacUrl(loopbackIp, result.boundPort as number);
    await engageProxy(pacUrl);
    healthyStreak = 0;
    return publish({
      phase: 'proxy',
      boundPort: result.boundPort,
      pacUrl,
      loopbackIp,
      proxyActive: true,
      lastProbeAt,
      lastError: 'a .dig navigation failed via the direct path',
    });
  }

  return {
    probe,
    reportNavigationError,
    getSnapshot: () => ({ ...snapshot }),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async dispose() {
      if (snapshot.phase === 'proxy') await disengageProxy();
      listeners.clear();
    },
  };
}
