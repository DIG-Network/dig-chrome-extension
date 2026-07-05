import type { ReactElement } from 'react';
import { render } from '@testing-library/react';
import { Provider } from 'react-redux';
import { IntlProvider } from 'react-intl';
import { vi } from 'vitest';
import { createStore, type AppStore } from '@/app/store';
import { TransportProvider } from '@/app/TransportContext';
import { messagesFor, DEFAULT_LOCALE } from '@/i18n';
import type { WalletTransport, Connection, Pairing } from '@/features/wallet/transport';

/** A configurable mock wallet transport for tests. */
export function makeTransport(overrides: Partial<WalletTransport> = {}): WalletTransport {
  const base: WalletTransport = {
    getConnection: vi.fn(async (): Promise<Connection> => ({ connected: false })),
    isConnected: vi.fn(async () => false),
    connect: vi.fn(
      async (): Promise<Pairing> => ({ uri: 'wc:test', approval: async () => ({ topic: 't', address: 'xch1abc' }) }),
    ),
    disconnect: vi.fn(async () => {}),
    request: vi.fn(async () => ({})),
  };
  return { ...base, ...overrides };
}

/** A transport that reports a live, connected Sage session with the given address. */
export function connectedTransport(address = 'xch1qqqqexampleaddressqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqzzzz'): WalletTransport {
  return makeTransport({
    getConnection: vi.fn(async () => ({ connected: true, address, network: 'mainnet', topic: 't' })),
    isConnected: vi.fn(async () => true),
  });
}

/** Wrap UI in the app providers (fresh store + mock transport + intl) for a component test. */
export function renderWithProviders(
  ui: ReactElement,
  opts: { transport?: WalletTransport; store?: AppStore } = {},
) {
  const transport = opts.transport ?? makeTransport();
  const store = opts.store ?? createStore(transport);
  return {
    store,
    transport,
    ...render(
      <Provider store={store}>
        <TransportProvider transport={transport}>
          <IntlProvider locale={DEFAULT_LOCALE} defaultLocale={DEFAULT_LOCALE} messages={messagesFor(DEFAULT_LOCALE)}>
            {ui}
          </IntlProvider>
        </TransportProvider>
      </Provider>,
    ),
  };
}
