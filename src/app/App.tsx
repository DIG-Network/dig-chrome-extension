import { useEffect, type ReactNode } from 'react';
import { Provider } from 'react-redux';
import { IntlProvider } from 'react-intl';
import { BugReportButton } from '@dignetwork/components';
import { store as defaultStore, type AppStore } from '@/app/store';
import { useAppDispatch, useAppSelector, useAppStore } from '@/app/hooks';
import { TransportProvider } from '@/app/TransportContext';
import { wcTransport, type WalletTransport } from '@/features/wallet/transport';
import { CompactLayout } from '@/layouts/CompactLayout';
import { ExpandedLayout } from '@/layouts/ExpandedLayout';
import { useLayoutMode, type Surface } from '@/app/layout';
import { routeFromHash } from '@/features/ui/uiSlice';
import { routeToHash } from '@/app/tabs';
import { installStorageSync } from '@/app/storageSync';
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

/** The mounted shell: layout switch + hash↔route sync + one-time boot side effects + bug widget. */
function Shell({ surface }: { surface: Surface }) {
  const dispatch = useAppDispatch();
  const store = useAppStore();
  const mode = useLayoutMode(surface);
  const tab = useAppSelector((s) => s.ui.tab);
  const walletView = useAppSelector((s) => s.ui.walletView);

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
    const next = routeToHash(tab, walletView);
    if (location.hash !== next) {
      try {
        history.replaceState(null, '', next);
      } catch {
        location.hash = next;
      }
    }
  }, [tab, walletView]);

  return (
    <>
      {mode === 'expanded' ? <ExpandedLayout surface={surface} /> : <CompactLayout surface={surface} />}
      <BugReportButton repo="dig-chrome-extension" />
    </>
  );
}

/**
 * The one React app, rendered by both entry points (`popup.html`, `app.html`). `surface` selects
 * the default chrome; a wide `app.html` upgrades to the expanded layout. The store + transport are
 * injectable so unit tests drive the same app with a mock backend.
 */
export function App({
  surface,
  store = defaultStore,
  transport = wcTransport,
}: {
  surface: Surface;
  store?: AppStore;
  transport?: WalletTransport;
}) {
  return (
    <Provider store={store}>
      <TransportProvider transport={transport}>
        <LocaleGate>
          <Shell surface={surface} />
        </LocaleGate>
      </TransportProvider>
    </Provider>
  );
}
