// Ambient augmentation of the `chrome.search` API with the dig-browser (Chromium fork) extensions
// used by src/background/search-engine.ts. Stock `@types/chrome` ships only `chrome.search.query`;
// the DIG browser additionally exposes `get`/`add`/`remove` and a richer `SearchEngine` shape for
// managing registered search providers. Declared here (not inline in the module) so the module stays
// free of the `@typescript-eslint/no-namespace` carve-out — ambient global augmentation is what a
// `.d.ts` is for (matching src/types/chia-wasm-bg.d.ts et al.).

declare global {
  namespace chrome.search {
    /** One entry in the browser's registered search-provider list. */
    interface SearchEngine {
      name: string;
      keyword?: string;
      faviconUrl?: string;
      searchUrl?: string;
      /** True for the provider currently set as the browser's default. */
      isDefault: boolean;
    }

    /** dig-browser extension: list every registered search provider. */
    function get(): Promise<SearchEngine[]>;
    /** dig-browser extension: register (or update) a search provider. */
    function add(engine: { name: string; keyword: string; faviconUrl: string; searchUrl: string }): Promise<void>;
    /** dig-browser extension: unregister a search provider by name. */
    function remove(engine: { name: string }): Promise<void>;
  }
}

export {};
