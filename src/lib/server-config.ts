/**
 * dig-node host config — the single source of truth for the local resolver address.
 *
 * The extension can resolve chia:// content through a LOCAL `dig-node` (renamed from
 * dig-companion) instead of the hosted RPC endpoint. That address is stored under the
 * `server.host` key in chrome.storage.local and is read by both the background SW (to
 * route fetches) and the options page (to show/edit it).
 *
 * Why this module exists: three surfaces used to disagree on the same key — the popup
 * called it "RPC Host" defaulting to port 80, the options page called it "Companion host"
 * defaulting to 8080, and the background fallback defaulted to 80. That meant a value set
 * on one surface was parsed differently on another. This module fixes that: ONE name (the
 * dig-node host), ONE default (`127.0.0.1:9778` — the canonical dig-node control port,
 * explicit IPv4 to avoid the Windows `localhost`→`::1` mismatch, #287), and ONE parser.
 *
 * It is a plain ES module (no chrome.* access) so it can be imported by the module SW
 * (background.js), the options page, and unit-tested under `node --test`.
 */

/**
 * The dig-node's default listen port. Canonically **9778** (#132) — an uncommon high port
 * clear of the collision-prone common-dev set (80/443/3000/5000/8000/8080/8888/9000) and the
 * sibling of the dig-wallet HTTP API's 9777. Was 8080 (the old dig-companion default) until
 * #132 moved the whole ecosystem (dig-node, digstore, this extension) to the new canonical port.
 */
export const DEFAULT_DIG_NODE_PORT = 9778;

/**
 * The default dig-node host:port shown when nothing is configured. Explicit IPv4 (`127.0.0.1`),
 * NEVER the bare word `localhost` (#287, live user-reported offline): on Windows `localhost`
 * resolves to `::1` (IPv6) FIRST, but the dig-node binds IPv4 `127.0.0.1` only — a `localhost`
 * fetch/WS then hits a closed `[::1]:9778` and the extension reports the node offline even while
 * it is running. `127.0.0.1` has no such ambiguity: it is the loopback address itself, not a name
 * subject to the OS resolver's address-family preference.
 */
export const DEFAULT_DIG_NODE_HOST = `127.0.0.1:${DEFAULT_DIG_NODE_PORT}`;

/**
 * Parse a user-entered dig-node host string into `{ url, port }`.
 *
 * Accepts `host`, `host:port`, or `http(s)://host[:port]`. A missing or out-of-range port
 * falls back to {@link DEFAULT_DIG_NODE_PORT} (9778); blank input falls back to the full
 * default host (explicit IPv4 `127.0.0.1`, #287 — see {@link DEFAULT_DIG_NODE_HOST}). The
 * scheme is stripped — the caller decides http/https. An EXPLICITLY typed host (e.g.
 * `localhost`) is preserved verbatim — this only substitutes the IPv4 literal for blank input.
 */
export function parseServerHost(host?: string | null): { url: string; port: number } {
  if (!host || !String(host).trim()) {
    return { url: '127.0.0.1', port: DEFAULT_DIG_NODE_PORT };
  }

  let url = String(host).trim().replace(/^https?:\/\//, '');

  // Pull a trailing :port off, if present.
  let port = DEFAULT_DIG_NODE_PORT;
  const portMatch = url.match(/:(\d+)$/);
  if (portMatch) {
    port = parseInt(portMatch[1], 10);
    url = url.replace(/:\d+$/, '');
  }

  // Validate the port; fall back to the dig-node default if nonsensical.
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    port = DEFAULT_DIG_NODE_PORT;
  }

  // A bare ":port" input (host stripped to empty) → the same explicit-IPv4 default (#287).
  if (!url) url = '127.0.0.1';

  return { url, port };
}

/** Render `{ url, port }` back to the canonical `url:port` string. */
export function formatServerHost(url: string, port: number): string {
  return `${url}:${port}`;
}

// ---- Local dig-node resolution (dig.local preferred, 127.0.0.1 fallback) --------------------
//
// The dig-installer makes the local dig-node reachable at TWO addresses:
//   1. bare `http://dig.local` (port 80, branded) — once the installer writes the hosts entry,
//   2. `http://127.0.0.1:<port>` (default 9778) — the always-on fallback that needs no hosts edit.
//
// Resolution PREFERS dig.local (cleaner, branded, no port) and falls back to 127.0.0.1:port.
// This is forward-compatible: until the installer writes the hosts entry, dig.local simply
// fails to connect and 127.0.0.1 is used. We do NOT re-add any manual-hosts-edit UI — the
// installer owns the hosts entry now.
//
// The fallback is the EXPLICIT IPv4 literal `127.0.0.1`, never the bare word `localhost` (#287):
// on Windows `localhost` resolves to `::1` (IPv6) FIRST, but the dig-node binds IPv4 only, so a
// `localhost` fetch/WS hit a closed `[::1]:<port>` and reported the node offline even while it
// was running. This holds regardless of which local alias was configured (`localhost`,
// `127.0.0.1`, `::1`, or nothing) — the fallback candidate itself is always `127.0.0.1`, so typing
// `127.0.0.1` to force IPv4 is honoured verbatim instead of being silently rewritten.

/** The bare, branded local dig-node address (port 80, no port suffix). Tried FIRST. */
export const DIG_LOCAL_URL = 'http://dig.local';

/**
 * Hosts that mean "the standard local dig-node", not a distinct/remote node the user is
 * pointing the extension at. Configuring one of these (with any port) keeps the normal
 * dig.local-first, localhost-fallback ladder; anything else is a genuine override (below).
 */
const LOCAL_ALIAS_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'dig.local']);

/**
 * Build the ordered try-list of local dig-node base URLs.
 *
 * §5.3 override precedence: an explicitly-configured host that names something OTHER than the
 * standard local aliases (`localhost` / `127.0.0.1` / `::1` / `dig.local`) is a genuine custom
 * node — it wins ENTIRELY over the ladder, so it is the ONLY candidate returned (the
 * dig.local/127.0.0.1 probes are skipped). Absent a custom host (blank input, or one of the
 * local aliases), the ladder is `dig.local` first, then `127.0.0.1:<port>` — the port coming
 * from the configured `server.host` (defaulting to {@link DEFAULT_DIG_NODE_PORT}).
 *
 * Previously this destructured only `{ port }` from the parsed host and silently discarded
 * `url`, so a configured custom host (e.g. `my-node.example.com:9000`) was NEVER actually
 * tried — only its port leaked into the fallback. Fixed: see #43 / #41 audit.
 *
 * The fallback candidate is ALWAYS the literal `127.0.0.1`, never `localhost` (#287): Windows
 * resolves `localhost` to `::1` first, which the IPv4-only dig-node never answers on, so the
 * ladder used to report the node offline even while it was running. This also fixes a second
 * #287 bug: previously the fallback was hardcoded to the word `localhost` regardless of which
 * alias was configured, so a user who typed `127.0.0.1` (to force IPv4) had it silently rewritten
 * back to `localhost` — now the fallback is `127.0.0.1` unconditionally, so that input is
 * honoured as-is.
 *
 * @param {string} [host] the configured `server.host`
 * @returns {string[]} `['http://<custom-host>:<port>']`, or
 *   `['http://dig.local', 'http://127.0.0.1:<port>']` when no custom host is configured
 */
export function digNodeCandidates(host?: string | null): string[] {
  const { url, port } = parseServerHost(host);
  if (url && !LOCAL_ALIAS_HOSTS.has(url.toLowerCase())) {
    return [`http://${url}:${port}`];
  }
  return [DIG_LOCAL_URL, `http://127.0.0.1:${port}`];
}

/**
 * Probe a single dig-node base URL for reachability with an injectable `fetch` + timeout.
 *
 * Uses a `no-cors` GET so a probe never needs CORS headers from the node; a `no-cors` response
 * is opaque (`ok:false`, `status:0`) yet still proves the socket was reachable — so we treat
 * ANY resolved fetch (not a thrown/aborted one) as reachable. A thrown fetch (connection
 * refused / DNS miss / abort) means unreachable.
 *
 * @param {string} baseUrl e.g. `http://dig.local`
 * @param {object} [opts]
 * @param {typeof fetch} [opts.fetch] injectable fetch (defaults to global)
 * @param {number} [opts.timeoutMs] abort after this many ms (default 1500)
 * @returns {Promise<boolean>} true if the node answered the socket
 */
export async function probeDigNode(
  baseUrl: string,
  { fetch: fetchImpl = fetch, timeoutMs = 1500 }: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<boolean> {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    // Trailing slash → the node's root/health endpoint.
    const url = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
    await fetchImpl(url, { method: 'GET', mode: 'no-cors', signal: ctrl ? ctrl.signal : undefined });
    return true; // resolved (even opaque) ⇒ the socket was reachable
  } catch {
    return false; // threw/aborted ⇒ unreachable
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Resolve the first reachable local dig-node base URL, trying {@link digNodeCandidates} in
 * order (dig.local, then localhost:port). Returns the reachable base URL, or `null` if NONE
 * is reachable (the dig-node is not installed/running — the caller then surfaces the install
 * prompt or falls back to the hosted RPC endpoint).
 *
 * @param {string} [host] the configured `server.host`
 * @param {object} [opts] forwarded to {@link probeDigNode} (`fetch`, `timeoutMs`)
 * @returns {Promise<string|null>} the reachable base URL, or null
 */
export async function resolveDigNode(
  host?: string | null,
  opts: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<string | null> {
  for (const base of digNodeCandidates(host)) {
    if (await probeDigNode(base, opts)) return base;
  }
  return null;
}
