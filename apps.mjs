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

/**
 * Ordered app-directory entries shown in the "App Store" tab of DIG Home.
 * Each: { name, host, url, glyph (emoji), blurb, chip, dig? }.
 * `dig: true` marks an on-DIG-Network destination (styled with the Chia/mint chip).
 */
export const DIG_APPS = [
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
export const DIG_HOME_FOOTER_LINKS = [
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
 * Classify an omnibox value the same way the native DIG Browser NTP does:
 *   - 'dig'    → a chia:// URL, urn:dig:, or a bare 64-hex store id (open on the DIG Network)
 *   - 'url'    → an http(s) URL or a bare domain (navigate)
 *   - 'search' → anything else (web search via DuckDuckGo)
 *
 * Mirrors `classify()` in dig_newtab.html so the two stay behaviourally identical.
 * @param {string} v raw omnibox value
 * @returns {'dig'|'url'|'search'}
 */
export function classifyOmnibox(v) {
  v = (v || '').trim();
  if (!v) return 'search';
  if (/^chia:\/\//i.test(v) || /^urn:dig:/i.test(v)) return 'dig';
  if (/^[0-9a-f]{64}([:/].*)?$/i.test(v)) return 'dig';
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
export function omniboxTarget(v) {
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
