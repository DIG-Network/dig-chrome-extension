/**
 * Popup tab model — the single source of truth for the 4-tab popup surface.
 *
 * The popup is organised as four tabs, in this order:
 *   1. resolver — the chia:// resolver (open a chia:// address, on/off toggle, node-resolution
 *      status + custom-node override; the extension's core purpose).
 *   2. wallet   — the full wallet (balances, receive, send, activity) over WalletConnect → Sage.
 *   3. shield   — DIG Shields: the active tab's verification + per-resource proof ledger.
 *   4. control  — the DIG Control Panel: manage a local dig-node, or a full-page install landing.
 *
 * This module is PURE (no DOM / chrome.*) so the tab set, order, default, and hash→tab
 * deep-link resolution are unit-testable and the popup renderer stays thin glue over it.
 */

/** The ordered tab set. Order === the visual tab order. @readonly */
export const TABS = Object.freeze(['resolver', 'wallet', 'shield', 'control']);

/**
 * The tab shown when the popup opens with no deep-link. The resolver is tab 1 and the
 * extension's core surface, so it is the default; a `#wallet`/`#shield`/`#control` hash
 * (e.g. from the DIG Home wallet pill) overrides it (see {@link resolveInitialTab}).
 */
export const DEFAULT_TAB = 'resolver';

/** True if `name` is one of the known tabs. */
export function isTab(name) {
  return typeof name === 'string' && TABS.includes(name);
}

/**
 * Resolve the tab to open from a `location.hash` (or bare tab name). A valid tab wins; anything
 * missing/unknown falls back to {@link DEFAULT_TAB}. Never throws.
 *
 * @param {string|null|undefined} hash e.g. `'#wallet'`, `'wallet'`, `''`
 * @returns {string} a member of {@link TABS}
 */
export function resolveInitialTab(hash) {
  const name = String(hash || '').replace(/^#/, '');
  return isTab(name) ? name : DEFAULT_TAB;
}

/** The DOM id of the tabpanel element for `tab`. */
export function tabPanelId(tab) {
  return `${tab}Panel`;
}

/** The stable, agent-driveable `data-testid` of the tab button for `tab`. */
export function tabTestId(tab) {
  return `tab-${tab}`;
}
