/**
 * dig-loader — pure view-model for the instant, never-blank DIG loader page (#311).
 *
 * On a `dig`-keyword / `chia://` / `urn:dig:chia:` / `<sub>.on.dig.net` URN-bar submit,
 * `handleDigUrlNavigation` (background/index.ts) flashes the tab to this extension page FIRST — an
 * instant-paint branded shell (mirroring `*.on.dig.net`'s loader-shell UX, `DigLoader.tsx`) — before
 * the §5.3/§5.4 node-or-sandbox resolve completes and the SW swaps the tab to the resolved
 * destination. The loader page itself does no resolving; it is a purely visual interstitial the SW
 * navigates PAST once the real target is known (or to the branded error page, `error-page.ts`, on
 * failure — both already recoverable: "Try again" / "Go to DIG Home").
 *
 * This module is DOM-free (no `chrome.*`/`window`) so the query-param parsing + display copy are
 * unit-tested; `src/entries/dig-loader.ts` is the DOM glue that renders it.
 */
import { decodeUrnParam } from '@/lib/dig-urn';

/** Generic placeholder shown when the loader is opened with no `?input=` context. */
const GENERIC_ADDRESS_PLACEHOLDER = 'your DIG address';

/**
 * Parse the loader page's `?input=<digUrl>` query string (a `location.search`-shaped string,
 * leading `?` optional) into the raw `chia://`/URN value the SW is resolving. Fully decodes until
 * stable (some navigation paths encode the value more than once — see `decodeUrnParam`). Returns
 * `null` for a missing/empty param (the loader was opened directly, with no resolve in flight).
 */
export function parseLoaderInput(search: string | null | undefined): string | null {
  const s = String(search ?? '');
  const qs = s.startsWith('?') ? s.slice(1) : s;
  const params = new URLSearchParams(qs);
  const raw = params.get('input');
  if (!raw) return null;
  const decoded = decodeUrnParam(raw);
  return decoded || null;
}

/**
 * A short, human-friendly display of the address currently resolving, for the loader's subtitle
 * ("Resolving <address>…"). Truncates with an ellipsis so a long store id + long resource path never
 * overflows the loader card; a missing/empty address falls back to a generic phrase rather than an
 * empty line.
 */
export function loaderDisplayAddress(input: string | null | undefined, maxLen = 64): string {
  const v = String(input ?? '').trim();
  if (!v) return GENERIC_ADDRESS_PLACEHOLDER;
  if (v.length <= maxLen) return v;
  return `${v.slice(0, maxLen)}…`;
}

/**
 * Build the extension URL the SW flashes the tab to first (`handleDigUrlNavigation`, #311):
 * `<extension-origin>/dig-loader.html?input=<digUrl>` (single-encoded — {@link parseLoaderInput}
 * decodes it back). `getURL` is the caller's `chrome.runtime.getURL` (injected so this stays
 * chrome-free/pure and unit-testable).
 */
export function buildLoaderPageUrl(getURL: (path: string) => string, digUrl: string): string {
  return getURL(`dig-loader.html?input=${encodeURIComponent(digUrl)}`);
}
