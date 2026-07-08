import { useEffect, type ReactNode } from 'react';
import { Provider } from 'react-redux';
import { IntlProvider } from 'react-intl';
import { AppView } from '@/features/apps/AppView';
import { store as defaultStore, type AppStore } from '@/app/store';
import { useAppDispatch, useAppSelector, useAppStore } from '@/app/hooks';
import { CompactLayout } from '@/layouts/CompactLayout';
import { ExpandedLayout } from '@/layouts/ExpandedLayout';
import { useLayoutMode, type Surface } from '@/app/layout';
import { routeFromHash } from '@/features/ui/uiSlice';
import { routeToHash } from '@/app/tabs';
import { installStorageSync } from '@/app/storageSync';
import { useBackgroundPrefetch } from '@/app/useBackgroundPrefetch';
import { useAppliedTheme } from '@/app/useAppliedTheme';
import { publishVersionGlobal } from '@/lib/version';
import { messagesFor, DEFAULT_LOCALE } from '@/i18n';

/** Provide react-intl using the store's active locale (falling back to English). */
function LocaleGate({ children }: { children: ReactNode }) {
  const locale = useAppSelector((s) => s.ui.locale);
  return (
    <IntlProvider locale={locale} defaultLocale={DEFAULT_LOCALE} messages={messagesFor(locale)}>
      {children}
    </IntlProvider>
  );
}

/**
 * The mounted shell: layout switch + hash↔route sync + one-time boot side effects + bug widget +
 * background prefetch. Mounting `useBackgroundPrefetch` (#168) HERE — not inside any one tab/view —
 * is what makes it fire regardless of which screen is showing: the mobile-OS Home tab never mounts
 * the wallet body, and Collectibles isn't mounted until its segmented tab is picked, so a per-view
 * fetch alone can't warm those caches ahead of navigation (§18.5a).
 */
function Shell({ surface }: { surface: Surface }) {
  const dispatch = useAppDispatch();
  const store = useAppStore();
  const mode = useLayoutMode(surface);
  const tab = useAppSelector((s) => s.ui.tab);
  const walletView = useAppSelector((s) => s.ui.walletView);
  const networkView = useAppSelector((s) => s.ui.networkView);

  // #168 — warm balances/assets/collectibles/activity on unlock + on wallet/index switch.
  useBackgroundPrefetch();
  // #111 — apply the active theme (light/dark/system) to the document; live for OS-theme changes.
  useAppliedTheme();

  // Boot: publish version (§6.7) + install the storage→store bridge (§3.4).
  useEffect(() => {
    publishVersionGlobal();
    let cleanup: (() => void) | undefined;
    void installStorageSync(store).then((fn) => {
      cleanup = fn;
    });
    return () => cleanup?.();
  }, [store]);

  // Hydrate route from the hash on mount + follow external hash changes (deep-link + pop-out).
  useEffect(() => {
    dispatch(routeFromHash(location.hash));
    const onHash = () => dispatch(routeFromHash(location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [dispatch]);

  // Keep the hash in sync with the route so ⤢ pop-out carries the current place.
  useEffect(() => {
    const next = routeToHash(tab, walletView, networkView);
    if (location.hash !== next) {
      try {
        history.replaceState(null, '', next);
      } catch {
        location.hash = next;
      }
    }
  }, [tab, walletView, networkView]);

  return (
    <>
      {mode === 'expanded' ? <ExpandedLayout surface={surface} /> : <CompactLayout surface={surface} />}
      {/* The in-window dApp app-view overlays either layout when a dApp is launched (§2.4a). */}
      <AppView />
    </>
  );
}

/**
 * The one React app, rendered by both entry points (`popup.html`, `app.html`). `surface` selects
 * the default chrome; a wide `app.html` upgrades to the expanded layout. The store is injectable so
 * unit tests drive the same app with a mock backend (the SW seam, via `chrome.runtime.sendMessage`).
 */
export function App({
  surface,
  store = defaultStore,
}: {
  surface: Surface;
  store?: AppStore;
}) {
  return (
    <Provider store={store}>
      <LocaleGate>
        <Shell surface={surface} />
      </LocaleGate>
    </Provider>
  );
}
