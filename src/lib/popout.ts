import { hasRuntime } from '@/lib/messaging';

/**
 * Open (or focus) the full-page `app.html` wallet tab, carrying the current route in the hash so
 * the popped-out view deep-links to the same place. Singleton: if an `app.html` tab already exists
 * it is focused instead of duplicated (the same pattern the legacy popup/NTP used). Closes the
 * popup afterward when running as the toolbar popup.
 *
 * @param hash the location hash to carry (e.g. `#wallet/activity`)
 * @param closeSelf whether to `window.close()` after opening (true in the popup surface)
 */
export async function popOutToFullpage(hash: string, closeSelf: boolean): Promise<void> {
  if (!hasRuntime() || !chrome.tabs) return;
  const url = chrome.runtime.getURL('app.html') + (hash || '');
  try {
    const existing = await chrome.tabs.query({ url });
    const found = existing[0];
    if (found?.id != null) {
      await chrome.tabs.update(found.id, { active: true });
    } else {
      await chrome.tabs.create({ url });
    }
  } finally {
    if (closeSelf) {
      try {
        window.close();
      } catch {
        /* ignore */
      }
    }
  }
}
