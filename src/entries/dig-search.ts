/**
 * dig-search — the custom DIG search provider's resolver page (#362 Tier 4).
 *
 * The DIG search engine's `search_url` is an HTTPS sentinel on a DIG domain (`search-fallback`'s
 * `DIG_SEARCH_MANIFEST_URL`); the background SW intercepts that navigation locally (a
 * `declarativeNetRequest` redirect + a `webNavigation` fallback) and lands the tab HERE, at
 * `dig-search.html?q=<the typed query>`. This page shows the branded DIG loader while it CLASSIFIES
 * the query (shared `decideSearchRoute` → `classifyDigInput`) and either:
 *   - loads a DIG address through the LOCAL NODE (a `chia` route → the background `navigateToDigUrl`
 *     §5.4 path; an `on-dig-net` route → `navigateDigInput`, which resolves HEAD→URN #308), or
 *   - redirects to the user's CONFIGURED fallback web-search engine (default DuckDuckGo) for a normal
 *     query — loop-free, since the fallback is never the DIG sentinel.
 *
 * Pure DOM glue; the decision logic + fallback builder live in the unit-tested `@/lib/search-fallback`.
 */
import { decideSearchRoute, getFallbackTemplate } from '@/lib/search-fallback';
import { ACTIONS } from '@/lib/messages';
import { publishVersionGlobal } from '@/lib/version';

/** Read a query-string parameter (empty string if absent / malformed). */
function param(name: string): string {
  try {
    return new URLSearchParams(location.search).get(name) ?? '';
  } catch {
    return '';
  }
}

/** Fire-and-forget a background message (the SW replaces THIS tab on a DIG route). */
function send(msg: Record<string, unknown>): void {
  try {
    chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError);
  } catch {
    /* SW gone — the redirect fallback below still covers non-DIG queries */
  }
}

async function run(): Promise<void> {
  publishVersionGlobal();
  const q = param('q').trim();
  const echo = document.getElementById('digSearchQuery');
  if (echo) echo.textContent = q;

  // No query → the DIG Home new-tab surface.
  if (!q) {
    location.replace('newtab.html');
    return;
  }

  const template = await getFallbackTemplate();
  const route = decideSearchRoute(q, template);
  if (route.kind === 'chia') {
    send({ action: ACTIONS.navigateToDigUrl, url: route.chiaUrl });
  } else if (route.kind === 'on-dig-net') {
    send({ action: ACTIONS.navigateDigInput, input: route.host });
  } else {
    location.replace(route.url);
  }
}

void run();
