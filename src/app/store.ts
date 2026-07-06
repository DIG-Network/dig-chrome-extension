import { configureStore } from '@reduxjs/toolkit';
import { api } from '@/api/api';
import { uiReducer } from '@/features/ui/uiSlice';
import { walletReducer } from '@/features/wallet/walletSlice';
// Register feature endpoints (side-effect imports wire them into the single api slice).
import '@/features/wallet/custodyApi';
import '@/features/resolver/resolverApi';
import '@/features/shield/shieldApi';
import '@/features/control/controlApi';

/**
 * Create the Redux store. Every server/backend interaction routes over the SW seam
 * (`chromeBaseQuery` → `chrome.runtime.sendMessage`), so no transport is injected — unit tests
 * drive the same store with a mocked `chrome.runtime.sendMessage`.
 */
export function createStore() {
  return configureStore({
    reducer: {
      [api.reducerPath]: api.reducer,
      ui: uiReducer,
      wallet: walletReducer,
    },
    middleware: (getDefault) => getDefault().concat(api.middleware),
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

/** The app store singleton. Tests build a fresh one with `createStore()` + a mocked SW. */
export const store = createStore();

export type AppStore = ReturnType<typeof createStore>;
export type RootState = ReturnType<AppStore['getState']>;
export type AppDispatch = AppStore['dispatch'];
