/**
 * search-fallback — the custom DIG search provider's classify-or-fall-through core (#362 Tier 4).
 *
 * Chrome exposes NO API to read the user's real default search engine, and routing a non-DIG query
 * back through the default engine would infinite-loop when DIG itself IS the default. So the DIG
 * search provider does NOT auto-detect the user's engine: its `search_url` points at a sentinel on a
 * DIG domain that the extension intercepts locally and hands to the in-extension resolver page, which
 * CLASSIFIES the query (shared `classifyDigInput`) and either loads it as a DIG address via the local
 * node OR redirects to a CONFIGURABLE fallback web search engine (default DuckDuckGo). This kills the
 * "type a chia:// address → bounce through Google → redirect" lag: with DIG as the search engine the
 * FIRST hop already lands on our resolver, no third-party round-trip.
 *
 * This module owns: the fallback-engine preset list + storage key + URL builder, the sentinel matcher
 * the SW uses to recognize a DIG-search navigation, and the PURE per-query route decision
 * ({@link decideSearchRoute}) the resolver page executes. All pure/unit-tested except the tiny
 * storage read {@link getFallbackTemplate}.
 */
import { classifyDigInput } from '@/lib/dig-nav';

/** A selectable fallback web-search engine. `template` interpolates the query at `%s`. */
export interface SearchEngine {
  id: string;
  label: string;
  template: string;
}

/**
 * The fallback-engine preset list shown in DIG settings. DuckDuckGo is first (the loop-free,
 * privacy-respecting default); a `custom` entry lets the user paste any `…%s…` template.
 */
export const SEARCH_FALLBACK_PRESETS: readonly SearchEngine[] = [
  { id: 'duckduckgo', label: 'DuckDuckGo', template: 'https://duckduckgo.com/?q=%s' },
  { id: 'google', label: 'Google', template: 'https://www.google.com/search?q=%s' },
  { id: 'brave', label: 'Brave', template: 'https://search.brave.com/search?q=%s' },
  { id: 'bing', label: 'Bing', template: 'https://www.bing.com/search?q=%s' },
];

/** `chrome.storage.local` key persisting the chosen fallback-engine URL template (with `%s`). */
export const SEARCH_FALLBACK_KEY = 'search.fallback.url';

/** Default fallback engine: DuckDuckGo (private, and never the loop-risk of the user's own default). */
export const DEFAULT_SEARCH_FALLBACK = SEARCH_FALLBACK_PRESETS[0].template;

/**
 * The DIG search provider's `search_url` sentinel: an HTTPS URL on a verified DIG domain (Chrome
 * requires `search_url` be HTTPS on a Search-Console-verified domain — a `chrome-extension://`
 * `search_url` is NOT permitted). The extension intercepts navigations to this sentinel locally
 * (a `declarativeNetRequest` redirect + a `webNavigation` fallback) and rewrites them to the
 * in-extension resolver page — so the query never actually leaves the browser to hit `dig.net`.
 * The manifest form uses the OpenSearch `{searchTerms}` placeholder; this constant is the runtime
 * host+path the SW matches on.
 */
export const DIG_SEARCH_SENTINEL_ORIGIN = 'https://dig.net';
export const DIG_SEARCH_SENTINEL_PATH = '/dig-search';
/** The full manifest `search_url` template (OpenSearch `{searchTerms}` placeholder). */
export const DIG_SEARCH_MANIFEST_URL = `${DIG_SEARCH_SENTINEL_ORIGIN}${DIG_SEARCH_SENTINEL_PATH}?q={searchTerms}`;
/** The in-extension resolver page the sentinel redirects to (relative to the extension root). */
export const DIG_SEARCH_RESOLVER_PAGE = 'dig-search.html';

/**
 * Build a fallback web-search URL from a `%s` template + a raw query. A template missing `%s` (a
 * malformed custom entry) falls back to the DuckDuckGo default rather than producing a broken URL.
 */
export function buildFallbackSearchUrl(template: string | null | undefined, query: string): string {
  const t = typeof template === 'string' && template.includes('%s') ? template : DEFAULT_SEARCH_FALLBACK;
  return t.replace('%s', encodeURIComponent(query));
}

/**
 * If `url` is a DIG-search sentinel navigation (`https://[www.]dig.net/dig-search?q=…`), return the
 * decoded query; otherwise `null`. Used by the SW to recognize the search-provider hop and redirect
 * it to the resolver page locally (bounce-free).
 */
export function matchDigSearchSentinel(url: string | null | undefined): string | null {
  const s = String(url ?? '');
  const m = s.match(/^https?:\/\/(?:www\.)?dig\.net\/dig-search\?(?:[^#]*&)?q=([^&#]*)/i);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1].replace(/\+/g, ' '));
  } catch {
    return m[1];
  }
}

/** What the DIG-search resolver page should do with a query (the pure decision the page executes). */
export type SearchRoute =
  | { kind: 'chia'; chiaUrl: string }
  | { kind: 'on-dig-net'; host: string }
  | { kind: 'redirect'; url: string };

/**
 * Decide the route for a DIG-search query (#362 Tier 4): a DIG address (`urn`) loads via the local
 * node (`chia` → the background `navigateToDigUrl` path); an `*.on.dig.net`/`.dig` shorthand resolves
 * HEAD→URN (`on-dig-net`); everything else — a plain URL or free text — becomes a `redirect` (the URL
 * itself, or the configured fallback search engine for free text). Loop-free: a non-DIG query goes to
 * the chosen fallback engine, never back through the DIG sentinel.
 */
export function decideSearchRoute(query: string | null | undefined, fallbackTemplate: string): SearchRoute {
  const c = classifyDigInput(query);
  if (c.kind === 'urn') return { kind: 'chia', chiaUrl: c.chiaUrl };
  if (c.kind === 'on-dig-net') return { kind: 'on-dig-net', host: c.host };
  if (c.kind === 'url') return { kind: 'redirect', url: c.url };
  return { kind: 'redirect', url: buildFallbackSearchUrl(fallbackTemplate, c.query) };
}

/**
 * Read the configured fallback-engine template from `chrome.storage.local`, defaulting to DuckDuckGo
 * when unset or malformed (no `%s`). The one impure helper in this module.
 */
export async function getFallbackTemplate(): Promise<string> {
  try {
    const got = await chrome.storage.local.get(SEARCH_FALLBACK_KEY);
    const v = got[SEARCH_FALLBACK_KEY];
    return typeof v === 'string' && v.includes('%s') ? v : DEFAULT_SEARCH_FALLBACK;
  } catch {
    return DEFAULT_SEARCH_FALLBACK;
  }
}
