/**
 * The declarativeNetRequest rule that lets the extension's OWN in-window app-view iframe embed
 * `*.on.dig.net` dApps (#66).
 *
 * on.dig.net (the DIG subdomain resolver) serves its content with `X-Frame-Options: DENY` +
 * CSP `frame-ancestors 'none'` — correct clickjacking protection for the arbitrary user content it
 * hosts, but it also stops the extension's app-view from embedding a DIG dApp in-window (the embed
 * is refused → the app-view falls back to a browser tab). This rule strips those two framing headers
 * from on.dig.net responses so the app-view can render them in-window.
 *
 * It is scoped as tightly as declarativeNetRequest allows and is installed EPHEMERALLY — only while
 * the app-view is actively showing an on.dig.net dApp (added on open, removed on close), never as a
 * standing global rule:
 *   - `requestDomains: ['on.dig.net']` — DIG's own resolver content only (subdomains included),
 *   - `resourceTypes: ['sub_frame']` — only iframe embeds, never a top-level navigation, and
 *   - `tabIds: [tabId]` when the app-view runs in a tab (the expanded layout / app.html), pinning
 *     the strip to that one tab. In the popup (no tab id) the rule is domain+sub-frame scoped and
 *     still ephemeral.
 * Because it is removed the moment the app-view closes, on.dig.net keeps its full framing protection
 * against every OTHER embedder at all other times.
 *
 * Pure (no chrome or DOM APIs) so the service worker AND unit tests import the exact same rule shape.
 */

/** The declarativeNetRequest session-rule id for the app-view framing bypass (id 1 = the legacy dig.local cleanup rule). */
export const APPVIEW_FRAMING_RULE_ID = 2;

/** The single host whose framing headers the bypass strips — DIG's own subdomain resolver. */
export const FRAMED_HOST = 'on.dig.net';

/** A declarativeNetRequest `modifyHeaders` session rule stripping on.dig.net's framing headers. */
export interface FramingBypassRule {
  id: number;
  priority: number;
  action: {
    type: 'modifyHeaders';
    responseHeaders: Array<{ header: string; operation: 'remove' }>;
  };
  condition: {
    requestDomains: string[];
    resourceTypes: string[];
    tabIds?: number[];
  };
}

/**
 * Build the framing-bypass session rule. When `tabId` is a real tab (>= 0) the rule is pinned to
 * that tab; otherwise (the popup app-view, tab id −1/undefined) it is domain + sub-frame scoped.
 */
export function buildFramingBypassRule(tabId?: number): FramingBypassRule {
  const condition: FramingBypassRule['condition'] = {
    requestDomains: [FRAMED_HOST],
    resourceTypes: ['sub_frame'],
  };
  if (typeof tabId === 'number' && tabId >= 0) condition.tabIds = [tabId];
  return {
    id: APPVIEW_FRAMING_RULE_ID,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      responseHeaders: [
        { header: 'x-frame-options', operation: 'remove' },
        { header: 'content-security-policy', operation: 'remove' },
      ],
    },
    condition,
  };
}
