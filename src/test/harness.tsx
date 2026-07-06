import type { ReactElement } from 'react';
import { render } from '@testing-library/react';
import { Provider } from 'react-redux';
import { IntlProvider } from 'react-intl';
import { createStore, type AppStore } from '@/app/store';
import { messagesFor, DEFAULT_LOCALE } from '@/i18n';

/**
 * Wrap UI in the app providers (fresh store + intl) for a component test. Every backend interaction
 * routes over the SW seam (`chrome.runtime.sendMessage`), which tests mock directly — there is no
 * wallet transport to inject (the extension is a self-custody wallet, not a WalletConnect client).
 */
export function renderWithProviders(ui: ReactElement, opts: { store?: AppStore } = {}) {
  const store = opts.store ?? createStore();
  return {
    store,
    ...render(
      <Provider store={store}>
        <IntlProvider locale={DEFAULT_LOCALE} defaultLocale={DEFAULT_LOCALE} messages={messagesFor(DEFAULT_LOCALE)}>
          {ui}
        </IntlProvider>
      </Provider>,
    ),
  };
}
