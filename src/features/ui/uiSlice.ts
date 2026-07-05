import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import {
  DEFAULT_TAB,
  DEFAULT_WALLET_VIEW,
  resolveRoute,
  type Tab,
  type WalletView,
} from '@/app/tabs';
import { DEFAULT_LOCALE, isSupportedLocale } from '@/i18n/locales';

/** Cross-document client UI state (route + prefs), kept in sync via the storage bridge. */
export interface UiState {
  tab: Tab;
  walletView: WalletView;
  /** Active UI locale (persisted to `wallet.settings.locale`). */
  locale: string;
  /** Tier-3 "Advanced/Pro" disclosure toggle (persisted to `wallet.settings.advanced`). */
  advanced: boolean;
}

/** The persisted settings blob shape (subset of `wallet.settings`). */
interface PersistedSettings {
  locale?: string;
  advanced?: boolean;
}

function initialState(): UiState {
  const route = resolveRoute(typeof location !== 'undefined' ? location.hash : '');
  return { tab: route.tab, walletView: route.walletView, locale: DEFAULT_LOCALE, advanced: false };
}

const uiSlice = createSlice({
  name: 'ui',
  initialState: initialState(),
  reducers: {
    setTab(state, action: PayloadAction<Tab>) {
      state.tab = action.payload;
    },
    setWalletView(state, action: PayloadAction<WalletView>) {
      state.walletView = action.payload;
    },
    setLocale(state, action: PayloadAction<string>) {
      state.locale = isSupportedLocale(action.payload) ? action.payload : DEFAULT_LOCALE;
    },
    setAdvanced(state, action: PayloadAction<boolean>) {
      state.advanced = action.payload;
    },
    /** Hydrate route from a `location.hash` (on mount + on hashchange). */
    routeFromHash(state, action: PayloadAction<string>) {
      const route = resolveRoute(action.payload);
      state.tab = route.tab;
      state.walletView = route.walletView;
    },
    /** Merge durable settings read from storage (hydration + `chrome.storage.onChanged`). */
    settingsHydrated(state, action: PayloadAction<PersistedSettings | undefined>) {
      const s = action.payload;
      if (!s) return;
      if (typeof s.locale === 'string' && isSupportedLocale(s.locale)) state.locale = s.locale;
      if (typeof s.advanced === 'boolean') state.advanced = s.advanced;
    },
  },
});

export const { setTab, setWalletView, setLocale, setAdvanced, routeFromHash, settingsHydrated } =
  uiSlice.actions;
export const uiReducer = uiSlice.reducer;

export { DEFAULT_TAB, DEFAULT_WALLET_VIEW };
