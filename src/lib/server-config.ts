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
 * dig-node host), ONE default (`localhost:8080` — the dig-node's port), and ONE parser.
 *
 * It is a plain ES module (no chrome.* access) so it can be imported by the module SW
 * (background.js), the options page, and unit-tested under `node --test`.
 */

/** The dig-node's default listen port (matches dig-node / the old dig-companion default). */
export const DEFAULT_DIG_NODE_PORT = 8080;

/** The default dig-node host:port shown when nothing is configured. */
export const DEFAULT_DIG_NODE_HOST = `localhost:${DEFAULT_DIG_NODE_PORT}`;

/**
 * Parse a user-entered dig-node host string into `{ url, port }`.
 *
 * Accepts `host`, `host:port`, or `http(s)://host[:port]`. A missing or out-of-range port
 * falls back to {@link DEFAULT_DIG_NODE_PORT} (8080); blank input falls back to the full
 * default host. The scheme is stripped — the caller decides http/https.
 */
export function parseServerHost(host?: string | null): { url: string; port: number } {
  if (!host || !String(host).trim()) {
    return { url: 'localhost', port: DEFAULT_DIG_NODE_PORT };
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

  if (!url) url = 'localhost';

  return { url, port };
}

/** Render `{ url, port }` back to the canonical `url:port` string. */
export function formatServerHost(url: string, port: number): string {
  return `${url}:${port}`;
}

// ---- Local dig-node resolution (dig.local preferred, localhost fallback) -------------------
//
// The dig-installer makes the local dig-node reachable at TWO addresses:
//   1. bare `http://dig.local` (port 80, branded) — once the installer writes the hosts entry,
//   2. `http://localhost:<port>` (default 8080) — the always-on fallback that needs no hosts edit.
//
// Resolution PREFERS dig.local (cleaner, branded, no port) and falls back to localhost:port.
// This is forward-compatible: until the installer writes the hosts entry, dig.local simply
// fails to connect and localhost is used. We do NOT re-add any manual-hosts-edit UI — the
// installer owns the hosts entry now.

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
 * dig.local/localhost probes are skipped). Absent a custom host (blank input, or one of the
 * local aliases), the ladder is `dig.local` first, then `localhost:<port>` — the port coming
 * from the configured `server.host` (defaulting to {@link DEFAULT_DIG_NODE_PORT}).
 *
 * Previously this destructured only `{ port }` from the parsed host and silently discarded
 * `url`, so a configured custom host (e.g. `my-node.example.com:9000`) was NEVER actually
 * tried — only its port leaked into the localhost fallback. Fixed: see #43 / #41 audit.
 *
 * @param {string} [host] the configured `server.host`
 * @returns {string[]} `['http://<custom-host>:<port>']`, or
 *   `['http://dig.local', 'http://localhost:<port>']` when no custom host is configured
 */
export function digNodeCandidates(host?: string | null): string[] {
  const { url, port } = parseServerHost(host);
  if (url && !LOCAL_ALIAS_HOSTS.has(url.toLowerCase())) {
    return [`http://${url}:${port}`];
  }
  return [DIG_LOCAL_URL, `http://localhost:${port}`];
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
