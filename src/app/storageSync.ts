import { api } from '@/api/api';
import { settingsHydrated } from '@/features/ui/uiSlice';
import { storageGet } from '@/lib/messaging';
import type { AppStore } from '@/app/store';

const SETTINGS_KEY = 'wallet.settings';
const CONNECTION_KEY = 'wallet.connection';
/** Per-tag SW cache invalidation epochs are broadcast under this namespace (§3.4). */
const CACHE_EPOCH_PREFIX = 'walletCache.epoch.';

/** Map a `walletCache.epoch.<tag>` storage key to its RTK Query tag. */
function tagForEpochKey(key: string): string | null {
  if (!key.startsWith(CACHE_EPOCH_PREFIX)) return null;
  return key.slice(CACHE_EPOCH_PREFIX.length) || null;
}

/**
 * Hydrate durable settings and install the `chrome.storage.onChanged` → store bridge (§3.4). This
 * keeps popup + `app.html` (separate JS realms) convergent: a settings change re-hydrates the UI
 * slice; a connection change or a SW cache-epoch bump turns into an RTK Query `invalidateTags` so
 * both documents re-fetch one shared result rather than diverging. Returns an unsubscribe fn.
 */
export async function installStorageSync(store: AppStore): Promise<() => void> {
  // Initial hydration of durable settings.
  const initial = await storageGet<{ [SETTINGS_KEY]: { locale?: string; advanced?: boolean } }>(SETTINGS_KEY);
  store.dispatch(settingsHydrated(initial[SETTINGS_KEY]));

  if (typeof chrome === 'undefined' || !chrome.storage?.onChanged) {
    return () => {};
  }

  const listener = (
    changes: Record<string, { newValue?: unknown; oldValue?: unknown }>,
    area: string,
  ) => {
    if (area !== 'local' && area !== 'session') return;
    for (const key of Object.keys(changes)) {
      if (key === SETTINGS_KEY) {
        store.dispatch(
          settingsHydrated(changes[key].newValue as { locale?: string; advanced?: boolean } | undefined),
        );
      } else if (key === CONNECTION_KEY) {
        store.dispatch(api.util.invalidateTags(['Connection', 'Balances', 'Activity']));
      } else {
        const tag = tagForEpochKey(key);
        if (tag) store.dispatch(api.util.invalidateTags([tag as never]));
      }
    }
  };

  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
