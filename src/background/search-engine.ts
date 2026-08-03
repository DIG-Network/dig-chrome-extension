// -----------------------------------------------------------------------------------------------
// SEARCH ENGINE MANAGEMENT — the DIG Network default-search-provider wiring, extracted from the
// frozen service-worker monolith (`src/background/index.ts`) into this SEPARATE, FULLY-TYPED
// module (#1945, mirroring the #1464 `app-sign-handlers.ts` extraction).
//
// The SW monolith carries a justified file-level `// @ts-nocheck` because it is behaviour-frozen
// chrome.* glue relocated verbatim in #68 — but that carve-out was also swallowing NEW handlers
// added since the freeze, this block among them, letting them ship unchecked. This module lifts
// the search-engine registration + its message dispatch OUT of the frozen surface so it is
// type-checked and strict-linted like the rest of the codebase (§6.4); the SW just calls
// {@link registerSearchEngineManagement} once at startup. Behaviour is byte-for-byte the
// pre-extraction path.
//
// `chrome.search.get`/`add`/`remove` and `SearchEngine.isDefault` are a dig-browser (Chromium
// fork) extension of the standard `chrome.search` API (only `query` ships in stock
// `@types/chrome`); the ambient types for them live in `src/types/chrome-search.d.ts` so the calls
// here are fully typed rather than cast through `any`.
// -----------------------------------------------------------------------------------------------

/** The DIG Network search provider registered when no custom config is stored. */
const DEFAULT_SEARCH_ENGINE = {
  name: 'DIG Network Search',
  keyword: 'dig',
  faviconUrl: chrome.runtime.getURL('src/favicon.png'),
  searchUrl: 'https://rpc.dig.net/?urn=%s', // Default to rpc.dig.net
};

/** The result shape every handler below returns — `success: false` carries a human-readable `error`. */
type SearchResult =
  | { success: true; name: string }
  | { success: true; engine: chrome.search.SearchEngine | undefined }
  | { success: true; isDefault: boolean | undefined; defaultEngine: string | null }
  | { success: false; error: string };

/** True once the dig-browser `chrome.search.get`/`add`/`remove` extensions are present. */
function hasSearchApi(): boolean {
  return typeof chrome.search?.get === 'function';
}

/** Read the configured search URL from storage, falling back to the DIG default. */
async function getSearchUrl(): Promise<string> {
  const result = await chrome.storage.local.get(['search.url', 'search.enabled']);
  if (result['search.enabled'] && result['search.url']) {
    return result['search.url'] as string;
  }
  return DEFAULT_SEARCH_ENGINE.searchUrl;
}

/** Register (or re-register) the configured custom search engine with the browser. */
async function addCustomSearchEngine(): Promise<SearchResult> {
  try {
    if (!hasSearchApi()) {
      console.warn('DIG Extension: chrome.search API is not available');
      return { success: false, error: 'Search API not available' };
    }

    const searchUrl = await getSearchUrl();
    const result = await chrome.storage.local.get(['search.name', 'search.keyword']);

    const searchEngineName = (result['search.name'] as string) || DEFAULT_SEARCH_ENGINE.name;
    const searchKeyword = (result['search.keyword'] as string) || DEFAULT_SEARCH_ENGINE.keyword;

    // Check if search engine already exists
    const engines = await chrome.search.get();
    const existingEngine = engines.find((e) => e.name === searchEngineName);

    if (existingEngine) {
      // Remove existing engine first (Chrome doesn't support updating)
      try {
        await chrome.search.remove({ name: searchEngineName });
      } catch (e) {
        console.warn('DIG Extension: Could not remove existing search engine:', e);
      }
    }

    // Add the new search engine
    await chrome.search.add({
      name: searchEngineName,
      keyword: searchKeyword,
      faviconUrl: DEFAULT_SEARCH_ENGINE.faviconUrl,
      searchUrl: searchUrl,
    });

    console.log('DIG Extension: Custom search engine added:', searchEngineName);
    return { success: true, name: searchEngineName };
  } catch (error) {
    console.error('DIG Extension: Failed to add custom search engine:', error);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Return the browser's current default search provider, if any. */
async function getDefaultSearchEngine(): Promise<SearchResult> {
  try {
    if (!hasSearchApi()) {
      console.warn('DIG Extension: chrome.search API is not available');
      return { success: false, error: 'Search API not available' };
    }

    const engines = await chrome.search.get();
    const defaultEngine = engines.find((e) => e.isDefault);
    return { success: true, engine: defaultEngine };
  } catch (error) {
    console.error('DIG Extension: Failed to get default search engine:', error);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** True when the configured DIG search engine is currently the browser's default. */
async function isDigSearchDefault(): Promise<SearchResult> {
  try {
    if (!hasSearchApi()) {
      console.warn('DIG Extension: chrome.search API is not available');
      return { success: false, error: 'Search API not available' };
    }

    const result = await chrome.storage.local.get(['search.name']);
    const searchEngineName = (result['search.name'] as string) || DEFAULT_SEARCH_ENGINE.name;
    const engines = await chrome.search.get();
    const defaultEngine = engines.find((e) => e.isDefault);

    return {
      success: true,
      isDefault: defaultEngine && defaultEngine.name === searchEngineName,
      defaultEngine: defaultEngine ? defaultEngine.name : null,
    };
  } catch (error) {
    console.error('DIG Extension: Failed to check if DIG search is default:', error);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** The subset of an inbound runtime message the search-engine dispatcher reads. */
interface SearchEngineMessage {
  action?: string;
  name?: string;
  keyword?: string;
  url?: string;
  enabled?: boolean;
}

/**
 * Register the search-engine `chrome.runtime.onMessage` dispatcher plus the install/startup
 * hooks that (re-)add the configured search engine. Call once from the service worker's top level.
 */
export function registerSearchEngineManagement(): void {
  // Handle search engine management messages
  chrome.runtime.onMessage.addListener((message: SearchEngineMessage, _sender, sendResponse) => {
    if (message.action === 'addSearchEngine') {
      void (async () => {
        const result = await addCustomSearchEngine();
        sendResponse(result);
      })();
      return true; // Keep channel open for async response
    }

    if (message.action === 'getDefaultSearchEngine') {
      void (async () => {
        const result = await getDefaultSearchEngine();
        sendResponse(result);
      })();
      return true;
    }

    if (message.action === 'isDigSearchDefault') {
      void (async () => {
        const result = await isDigSearchDefault();
        sendResponse(result);
      })();
      return true;
    }

    if (message.action === 'updateSearchConfig') {
      // Save search configuration
      const storageData: Record<string, unknown> = {};
      if (message.name) storageData['search.name'] = message.name;
      if (message.keyword) storageData['search.keyword'] = message.keyword;
      if (message.url) storageData['search.url'] = message.url;
      if (message.enabled !== undefined) storageData['search.enabled'] = message.enabled;

      void chrome.storage.local.set(storageData).then(async () => {
        // Re-add search engine with new config
        const result = await addCustomSearchEngine();
        sendResponse(result);
      });
      return true;
    }

    return false;
  });

  // Add search engine on extension install/startup
  chrome.runtime.onInstalled.addListener(async () => {
    const result = await chrome.storage.local.get(['search.enabled']);
    if (result['search.enabled'] !== false) {
      // Default to enabled, add search engine
      await addCustomSearchEngine();
    }
  });

  chrome.runtime.onStartup.addListener(async () => {
    const result = await chrome.storage.local.get(['search.enabled']);
    if (result['search.enabled'] !== false) {
      await addCustomSearchEngine();
    }
  });
}
