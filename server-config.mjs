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
export function parseServerHost(host) {
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
export function formatServerHost(url, port) {
  return `${url}:${port}`;
}
