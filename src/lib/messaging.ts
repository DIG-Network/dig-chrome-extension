/**
 * Thin typed wrappers over `chrome.runtime.sendMessage` + `chrome.storage.local` for the React
 * shell. These are the ONLY place the shell touches those raw APIs directly, so the RTK Query
 * baseQuery, the storage-sync middleware, and feature hooks stay testable glue over a small seam.
 */

/** A message envelope routed over `chrome.runtime` — `action` is a `messages.mjs` ACTIONS value. */
export interface ActionMessage {
  action: string;
  [k: string]: unknown;
}

/** True when running inside an extension context with the runtime messaging API available. */
export function hasRuntime(): boolean {
  return typeof chrome !== 'undefined' && !!chrome.runtime && typeof chrome.runtime.sendMessage === 'function';
}

/**
 * Send one action message to the background service worker and resolve its reply. Rejects if the
 * runtime is unavailable or `chrome.runtime.lastError` is set, so callers get one honest failure
 * path (the baseQuery maps it to an RTK Query error → the four-state error UI).
 */
export function sendAction<T = unknown>(message: ActionMessage): Promise<T> {
  if (!hasRuntime()) {
    return Promise.reject(new Error('Extension runtime unavailable'));
  }
  return new Promise<T>((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(message, (reply: T) => {
        const err = chrome.runtime.lastError;
        if (err) {
          reject(new Error(err.message || 'Message failed'));
          return;
        }
        resolve(reply);
      });
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

/** Read one or more `chrome.storage.local` keys; resolves `{}` when storage is unavailable. */
export async function storageGet<T extends Record<string, unknown>>(keys: string | string[]): Promise<Partial<T>> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return {};
  return (await chrome.storage.local.get(keys)) as Partial<T>;
}

/** Write to `chrome.storage.local`; a no-op when storage is unavailable. */
export async function storageSet(items: Record<string, unknown>): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
  await chrome.storage.local.set(items);
}
