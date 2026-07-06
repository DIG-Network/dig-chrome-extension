import { configureStore } from '@reduxjs/toolkit';
import { api, type ThunkExtra } from '@/api/api';
import { uiReducer } from '@/features/ui/uiSlice';
import { walletReducer } from '@/features/wallet/walletSlice';
import { wcTransport, type WalletTransport } from '@/features/wallet/transport';
// Register feature endpoints (side-effect imports wire them into the single api slice).
import '@/features/wallet/walletApi';
import '@/features/wallet/custodyApi';
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
      wallet: walletReducer,
    },
    middleware: (getDefault) =>
      getDefault({ thunk: { extraArgument: extra } }).concat(api.middleware),
    // Batch RTK Query store notifications on the microtask queue rather than the default
    // requestAnimationFrame. `raf` defers a coalescing callback to the next animation frame (a ~16 ms
    // macrotask); under jsdom that frame can fire after a test's window is torn down and throw from
    // inside RTK's autoBatchEnhancer ("cancelAnimationFrame is not defined" / jsdom `_location`),
    // surfacing as a flaky "unhandled error" run even though every test passes. `tick`
    // (queueMicrotask) coalesces just as effectively for this UI and always drains within the turn
    // that scheduled it, so nothing escapes to a later frame.
    enhancers: (getDefaultEnhancers) => getDefaultEnhancers({ autoBatch: { type: 'tick' } }),
  });
}

/** The app store singleton (live transport). Tests use `createStore(mockTransport)`. */
export const store = createStore();

export type AppStore = ReturnType<typeof createStore>;
export type RootState = ReturnType<AppStore['getState']>;
export type AppDispatch = AppStore['dispatch'];
