import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `chrome.search.get`/`add`/`remove` are a dig-browser (Chromium fork) extension of the standard
 * `chrome.search` API — not present in jsdom's default `chrome` stub — so each test wires the
 * fakes it needs directly onto `chrome.search`/`chrome.storage.local`/`chrome.runtime`.
 */

type Listener = (message: unknown, sender: unknown, sendResponse: (r: unknown) => void) => boolean;

let messageListeners: Listener[];
let installedListeners: Array<() => void | Promise<void>>;
let startupListeners: Array<() => void | Promise<void>>;
let storage: Record<string, unknown>;
let engines: Array<{ name: string; keyword?: string; faviconUrl?: string; searchUrl?: string; isDefault: boolean }>;

const searchAdd = vi.fn(async (engine: { name: string; keyword: string; faviconUrl: string; searchUrl: string }) => {
  engines.push({ ...engine, isDefault: false });
});
const searchRemove = vi.fn(async ({ name }: { name: string }) => {
  engines = engines.filter((e) => e.name !== name);
});
const searchGet = vi.fn(async () => engines);

/** Await one microtask turn — flushes the dispatcher's `void (async () => {...})()` IIFE. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.resetModules();
  messageListeners = [];
  installedListeners = [];
  startupListeners = [];
  storage = {};
  engines = [];
  searchAdd.mockClear();
  searchRemove.mockClear();
  searchGet.mockClear();

  (globalThis as { chrome: unknown }).chrome = {
    runtime: {
      getURL: (path: string) => `chrome-extension://test-id/${path}`,
      onMessage: { addListener: (l: Listener) => messageListeners.push(l) },
      onInstalled: { addListener: (l: () => void) => installedListeners.push(l) },
      onStartup: { addListener: (l: () => void) => startupListeners.push(l) },
    },
    storage: {
      local: {
        get: vi.fn(async (keys: string[]) => Object.fromEntries(keys.map((k) => [k, storage[k]]))),
        set: vi.fn(async (values: Record<string, unknown>) => {
          Object.assign(storage, values);
        }),
      },
    },
    search: {
      get: searchGet,
      add: searchAdd,
      remove: searchRemove,
    },
  };
});

/** Import fresh (post `vi.resetModules`) and register — mirrors the SW's one-shot startup call. */
async function register() {
  const { registerSearchEngineManagement } = await import('./search-engine');
  registerSearchEngineManagement();
}

function dispatch(message: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve) => {
    for (const listener of messageListeners) {
      const took = listener(message, {}, resolve);
      if (took) return;
    }
    resolve(undefined);
  });
}

describe('registerSearchEngineManagement', () => {
  it('registers exactly one onMessage listener plus one onInstalled and one onStartup listener', async () => {
    await register();
    expect(messageListeners).toHaveLength(1);
    expect(installedListeners).toHaveLength(1);
    expect(startupListeners).toHaveLength(1);
  });

  it('addSearchEngine adds the DIG default engine when no custom config is stored', async () => {
    await register();
    const result = await dispatch({ action: 'addSearchEngine' });
    expect(result).toEqual({ success: true, name: 'DIG Network Search' });
    expect(searchAdd).toHaveBeenCalledWith({
      name: 'DIG Network Search',
      keyword: 'dig',
      faviconUrl: 'chrome-extension://test-id/src/favicon.png',
      searchUrl: 'https://rpc.dig.net/?urn=%s',
    });
  });

  it('addSearchEngine replaces an existing same-name engine (remove then add)', async () => {
    engines.push({ name: 'DIG Network Search', isDefault: false });
    await register();
    await dispatch({ action: 'addSearchEngine' });
    expect(searchRemove).toHaveBeenCalledWith({ name: 'DIG Network Search' });
    expect(searchAdd).toHaveBeenCalledTimes(1);
  });

  it('getDefaultSearchEngine returns the engine flagged isDefault', async () => {
    engines.push({ name: 'Other', isDefault: false }, { name: 'DIG Network Search', isDefault: true });
    await register();
    const result = await dispatch({ action: 'getDefaultSearchEngine' });
    expect(result).toEqual({ success: true, engine: { name: 'DIG Network Search', isDefault: true } });
  });

  it('isDigSearchDefault is true when the configured DIG engine name is the current default', async () => {
    engines.push({ name: 'DIG Network Search', isDefault: true });
    await register();
    const result = await dispatch({ action: 'isDigSearchDefault' });
    expect(result).toEqual({ success: true, isDefault: true, defaultEngine: 'DIG Network Search' });
  });

  it('isDigSearchDefault is false when a different engine is the current default', async () => {
    engines.push({ name: 'Some Other Engine', isDefault: true });
    await register();
    const result = await dispatch({ action: 'isDigSearchDefault' });
    expect(result).toEqual({ success: true, isDefault: false, defaultEngine: 'Some Other Engine' });
  });

  it('updateSearchConfig writes the search.* storage keys then re-adds the engine with the new config', async () => {
    await register();
    const result = await dispatch({
      action: 'updateSearchConfig',
      name: 'Custom Search',
      keyword: 'cs',
      url: 'https://example.com/?q=%s',
      enabled: true,
    });
    expect(storage).toMatchObject({
      'search.name': 'Custom Search',
      'search.keyword': 'cs',
      'search.url': 'https://example.com/?q=%s',
      'search.enabled': true,
    });
    expect(searchAdd).toHaveBeenCalledWith({
      name: 'Custom Search',
      keyword: 'cs',
      faviconUrl: 'chrome-extension://test-id/src/favicon.png',
      searchUrl: 'https://example.com/?q=%s',
    });
    expect(result).toEqual({ success: true, name: 'Custom Search' });
  });

  it('an unrelated action is not handled (listener returns false, sendResponse never called)', async () => {
    await register();
    const sendResponse = vi.fn();
    let took: boolean | undefined;
    for (const listener of messageListeners) {
      took = listener({ action: 'notSearchRelated' }, {}, sendResponse);
    }
    expect(took).toBe(false);
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it('onInstalled re-adds the search engine when search.enabled is not explicitly false', async () => {
    await register();
    await installedListeners[0]();
    await flush();
    expect(searchAdd).toHaveBeenCalledTimes(1);
  });

  it('onInstalled does NOT re-add the search engine when search.enabled is false', async () => {
    storage['search.enabled'] = false;
    await register();
    await installedListeners[0]();
    await flush();
    expect(searchAdd).not.toHaveBeenCalled();
  });

  it('onStartup re-adds the search engine when search.enabled is not explicitly false', async () => {
    await register();
    await startupListeners[0]();
    await flush();
    expect(searchAdd).toHaveBeenCalledTimes(1);
  });

  it('every handler reports Search-API-unavailable gracefully when chrome.search is missing', async () => {
    (globalThis as { chrome: { search?: unknown } }).chrome.search = undefined;
    await register();
    expect(await dispatch({ action: 'addSearchEngine' })).toEqual({ success: false, error: 'Search API not available' });
    expect(await dispatch({ action: 'getDefaultSearchEngine' })).toEqual({ success: false, error: 'Search API not available' });
    expect(await dispatch({ action: 'isDigSearchDefault' })).toEqual({ success: false, error: 'Search API not available' });
  });
});
