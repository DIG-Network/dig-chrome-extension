/**
 * DIG Home (new-tab) app directory + the omnibox classifier.
 *
 * Single source of truth for what the DIG Home new-tab page shows. Ported from the
 * native DIG Browser's NTP (`modules/ungoogled-chromium-windows/dig/newtab/dig_newtab.html`)
 * so the extension's new-tab override mirrors the browser experience on Chrome/Edge/Brave/Firefox.
 *
 * This is an ES module so it can be unit-tested under `node --test` and imported by the
 * new-tab page (newtab.js) as a module; the values are the same the browser NTP hard-codes.
 */
import { isDigShapedInput } from '@/lib/dig-nav';

/**
 * Ordered app-directory entries shown in the "App Store" tab of DIG Home.
 * Each: { name, host, url, glyph (emoji), blurb, chip, dig? }.
 * `dig: true` marks an on-DIG-Network destination (styled with the Chia/mint chip).
 */
/** One DIG Home app-directory entry. `dig: true` marks an on-DIG-Network destination. */
export interface DigApp {
  name: string;
  host: string;
  url: string;
  glyph: string;
  blurb: string;
  chip: string;
  dig?: boolean;
}

export const DIG_APPS: DigApp[] = [
  {
    name: 'DIGHUb',
    host: 'hub.dig.net',
    url: 'https://hub.dig.net',
    glyph: '⛈️', // ⛈️-adjacent: matches the browser NTP's ☈ well glyph
    blurb: 'Publish & manage your sites on the DIG Network — your wallet is your account.',
    chip: 'Open',
  },
  {
    name: 'XCH Annuity',
    host: 'xchannuity.app',
    url: 'https://xchannuity.app',
    glyph: '\u{1F3DB}️', // 🏛️
    blurb: 'Private, self-custodial annuities — a legacy secured by Chia.',
    chip: 'Open',
  },
  {
    name: 'TibetSwap',
    host: 'v2.tibetswap.io',
    url: 'https://v2.tibetswap.io',
    glyph: '\u{1F4B0}', // 💰
    blurb: 'Swap XCH ↔ tokens. Get $DIG here to publish on the DIG Network.',
    chip: 'Buy $DIG',
    dig: true,
  },
  {
    name: 'Docs',
    host: 'docs.dig.net',
    url: 'https://docs.dig.net',
    glyph: '\u{1F4D6}', // 📖
    blurb: 'Learn the chia:// protocol, the CLI, and how to build on the DIG Network.',
    chip: 'Read',
  },
];

/**
 * The DIG CAT asset id (tail hash) — pinned, mirrors hub `apps/web/lib/links.js` so the
 * dexie/9mm Get-$DIG venue URLs are byte-identical to the hub's canonical sources.
 */
const DIG_ASSET_ID =
  'a406d3a9de984d03c9591c10d917593b434d5263cabe2b42f6b367df16832f81';

/**
 * Footer links shown beneath DIG Home. The Get-$DIG block surfaces the canonical THREE
 * venues in order (TibetSwap, dexie.space, xch.9mm.pro — mirrors hub `GET_DIG_SOURCES`), so
 * the new-tab footer offers the same acquisition paths as the rest of the ecosystem.
 */
/** One footer link shown beneath DIG Home. */
export interface FooterLink {
  label: string;
  url: string;
}

export const DIG_HOME_FOOTER_LINKS: FooterLink[] = [
  { label: 'DIG Network', url: 'https://dig.net' },
  { label: 'DIGHUb', url: 'https://hub.dig.net' },
  { label: 'Docs', url: 'https://docs.dig.net' },
  { label: 'Get $DIG · TibetSwap', url: 'https://v2.tibetswap.io/' },
  { label: 'Get $DIG · dexie', url: `https://dexie.space/offers/${DIG_ASSET_ID}/XCH` },
  { label: 'Get $DIG · 9mm.pro', url: `https://xch.9mm.pro/token/${DIG_ASSET_ID}` },
];

/** Web-search fallback for non-DIG omnibox queries — DuckDuckGo (private by default). */
export const WEB_SEARCH_URL = 'https://duckduckgo.com/?q=';

/**
 * Classify an omnibox value into the three destination kinds:
 *   - 'dig'    → a DIG address (a `chia://` URL, `urn:dig:`, a bare 64-hex store id, a dig-dns
 *                `<label>.dig` host, OR an `*.on.dig.net` / `<name>.dig` shorthand) → open on the
 *                DIG Network
 *   - 'url'    → an http(s) URL or a bare domain (navigate)
 *   - 'search' → anything else (web search)
 *
 * The DIG-vs-not recognition delegates to the SHARED {@link isDigShapedInput} (dig-nav.ts) so the
 * omnibox, the raw URL-bar interception (#310), the toolbar URN bars (#306), and the custom DIG
 * search provider (#362) all agree on what counts as a DIG address — one classifier, no drift. (This
 * ADDS `.dig` / `.on.dig.net` recognition over the earlier NTP-mirrored form; the `chia://`, `urn:`,
 * and bare-hex cases are unchanged.)
 * @param {string} v raw omnibox value
 * @returns {'dig'|'url'|'search'}
 */
export function classifyOmnibox(v: string): 'dig' | 'url' | 'search' {
  v = (v || '').trim();
  if (!v) return 'search';
  if (isDigShapedInput(v)) return 'dig';
  if (/^https?:\/\//i.test(v)) return 'url';
  if (/^[^\s]+\.[^\s]{2,}([/?#].*)?$/.test(v) && !/\s/.test(v)) return 'url';
  return 'search';
}

/**
 * Resolve a classified omnibox value to the URL to navigate to.
 * - 'dig'    → chia://<normalised> (scheme/urn prefixes stripped, re-prefixed chia://)
 * - 'url'    → the URL, https:// added if no scheme
 * - 'search' → DuckDuckGo search URL
 * @param {string} v raw omnibox value
 * @returns {string} destination URL
 */
export function omniboxTarget(v: string): string {
  v = (v || '').trim();
  const kind = classifyOmnibox(v);
  if (kind === 'dig') {
    const bare = v.replace(/^chia:\/\//i, '').replace(/^urn:dig:/i, '');
    return 'chia://' + bare;
  }
  if (kind === 'url') {
    return /^https?:\/\//i.test(v) ? v : 'https://' + v;
  }
  return WEB_SEARCH_URL + encodeURIComponent(v);
}

/** One omnibox autocomplete row: `content` is navigated on accept; `description` is the shown text. */
export interface OmniboxSuggestion {
  content: string;
  description: string;
}

/** The reply the `dig` omnibox keyword renders as the user types (#291). */
export interface OmniboxSuggestReply {
  defaultSuggestion: { description: string };
  suggestions: OmniboxSuggestion[];
}

/**
 * XML-escape a value for a `chrome.omnibox` description. The description string is parsed as XML
 * markup by Chrome (it supports `<match>`/`<url>`/`<dim>`), so a raw `&`, `<`, or `>` in a URL or
 * query throws — escape them. Applied to every dynamic fragment interpolated into a description.
 */
export function escapeOmnibox(s: string): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Build the omnibox suggestions the `dig` keyword shows as the user types (#291): a
 * `setDefaultSuggestion` description plus the single best autocomplete row, classified the same way
 * as {@link classifyOmnibox} — a DIG address opens on the DIG Network (routed through the §5.3
 * node-or-sandbox navigation), a URL navigates, anything else is a web search. Malformed / empty
 * input yields a helpful default with no rows. All interpolated text is XML-escaped
 * ({@link escapeOmnibox}) so `chrome.omnibox` never throws on a `&`/`<`/`>`.
 */
export function omniboxSuggestions(v: string): OmniboxSuggestReply {
  const text = (v || '').trim();
  if (!text) {
    return { defaultSuggestion: { description: 'Type a chia:// address, a store id, or a search' }, suggestions: [] };
  }
  const kind = classifyOmnibox(text);
  const target = omniboxTarget(text);
  const safeTarget = escapeOmnibox(target);
  if (kind === 'dig') {
    return {
      defaultSuggestion: { description: `Open on the DIG Network: ${safeTarget}` },
      suggestions: [{ content: target, description: `Open ${safeTarget}` }],
    };
  }
  if (kind === 'url') {
    return {
      defaultSuggestion: { description: `Go to ${safeTarget}` },
      suggestions: [{ content: target, description: `Go to ${safeTarget}` }],
    };
  }
  const safeText = escapeOmnibox(text);
  return {
    defaultSuggestion: { description: `Search the web for "${safeText}"` },
    suggestions: [{ content: target, description: `Search for ${safeText}` }],
  };
}
