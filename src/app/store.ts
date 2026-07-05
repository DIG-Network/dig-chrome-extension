import { configureStore } from '@reduxjs/toolkit';
import { api, type ThunkExtra } from '@/api/api';
import { uiReducer } from '@/features/ui/uiSlice';
import { wcTransport, type WalletTransport } from '@/features/wallet/transport';
// Register feature endpoints (side-effect imports wire them into the single api slice).
import '@/features/wallet/walletApi';
import '@/features/resolver/resolverApi';
import '@/features/shield/shieldApi';
import '@/features/control/controlApi';

/**
 * Create the Redux store. The wallet transport is injected as the thunk `extra` argument so the
 * RTK Query wallet endpoints have a testable seam (a mock transport in unit tests, the live
 * WalletConnect transport in the extension).
 */
export function createStore(transport: WalletTransport = wcTransport) {
  const extra: ThunkExtra = { transport };
  return configureStore({
    reducer: {
      [api.reducerPath]: api.reducer,
      ui: uiReducer,
    },
    middleware: (getDefault) =>
      getDefault({ thunk: { extraArgument: extra } }).concat(api.middleware),
  });
}

/** The app store singleton (live transport). Tests use `createStore(mockTransport)`. */
export const store = createStore();

export type AppStore = ReturnType<typeof createStore>;
export type RootState = ReturnType<AppStore['getState']>;
export type AppDispatch = AppStore['dispatch'];
