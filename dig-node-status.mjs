/**
 * dig-node install prompt + "dig-node required" error mapping.
 *
 * The extension can resolve chia:// content through a LOCAL dig-node (renamed from
 * dig-companion). When that node is not installed/running, two surfaces need a single,
 * consistent, plain-language message telling the user to install it:
 *   - the popup (a soft banner with an "Install dig-node" link), and
 *   - a dig-node-required load failure (mapped here, not to the generic network error).
 *
 * The installer is universal (Windows service / systemd / launchd) and lives at the
 * dig-installer releases page. Keeping the copy + URL here means the popup, options page,
 * and error path can never drift on what to tell the user.
 *
 * Plain ES module (no chrome.* / DOM) so the module SW (background.js), the popup, and the
 * options page can all import it, and it is unit-testable under `node --test`.
 */

/** The universal dig-node installer (Windows/macOS/Linux) — releases page. */
export const DIG_INSTALLER_URL = 'https://github.com/DIG-Network/dig-installer/releases';

/**
 * The friendly, plain-language prompt shown when the dig-node isn't reachable.
 * Returns a stable shape `{ title, body, installLabel, installUrl }` so every surface renders
 * the same words. NEVER includes protocol jargon (retrieval keys, merkle, singletons, …).
 *
 * @returns {{title: string, body: string, installLabel: string, installUrl: string}}
 */
export function digNodeInstallPrompt() {
  return {
    title: 'Run DIG content locally',
    body:
      'Install the dig-node to resolve chia:// addresses on your own machine — faster, ' +
      'private, and it works offline once content is cached. It installs in one step on ' +
      'Windows, macOS, and Linux. Without it, the extension uses the hosted network instead.',
    installLabel: 'Install dig-node',
    installUrl: DIG_INSTALLER_URL,
  };
}

/**
 * Failure messages that mean "the user pointed the extension at a LOCAL dig-node that isn't
 * running/installed" (as opposed to a generic upstream/network error). These map to the
 * install prompt rather than the generic "network unreachable" message.
 */
const DIG_NODE_REQUIRED_PATTERNS = [
  /dig-?node/i,                 // explicit "dig-node not running" etc.
  /local node/i,
  /econnrefused/i,             // socket refused on loopback
  /dig\.local/i,               // the branded local host failed to resolve/connect
  /localhost(?::\d+)?/i,       // the localhost fallback failed
  /127\.0\.0\.1(?::\d+)?/i,
];

/**
 * True when a raw failure message indicates the local dig-node is required but not reachable.
 * Used to decide whether to surface the install prompt instead of the generic network error.
 *
 * @param {string|null|undefined} rawMessage
 * @returns {boolean}
 */
export function isDigNodeRequiredError(rawMessage) {
  const m = String(rawMessage || '');
  if (!m) return false;
  return DIG_NODE_REQUIRED_PATTERNS.some((p) => p.test(m));
}
