import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import {
  DEFAULT_TAB,
  DEFAULT_WALLET_VIEW,
  DEFAULT_NETWORK_VIEW,
  resolveRoute,
  type Tab,
  type WalletView,
  type NetworkView,
} from '@/app/tabs';
import { DEFAULT_LOCALE, isSupportedLocale } from '@/i18n/locales';

/** Cross-document client UI state (route + prefs), kept in sync via the storage bridge. */
export interface UiState {
  tab: Tab;
  walletView: WalletView;
  /** The Network screen's active sub-view (resolver | shield | control). */
  networkView: NetworkView;
  /** Active UI locale (persisted to `wallet.settings.locale`). */
  locale: string;
  /** Tier-3 "Advanced/Pro" disclosure toggle (persisted to `wallet.settings.advanced`). */
  advanced: boolean;
  /** The dApp opened in the in-window app-view (mobile-OS "app launch"), else null. Ephemeral. */
  openApp: OpenApp | null;
}

/** A dApp launched into the in-window app-view: its display name + absolute launch URL. */
export interface OpenApp {
  slug: string;
  name: string;
  link: string;
}

/** The persisted settings blob shape (subset of `wallet.settings`). */
interface PersistedSettings {
  locale?: string;
  advanced?: boolean;
}

function initialState(): UiState {
  const route = resolveRoute(typeof location !== 'undefined' ? location.hash : '');
  return { tab: route.tab, walletView: route.walletView, networkView: route.networkView, locale: DEFAULT_LOCALE, advanced: false, openApp: null };
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
    setNetworkView(state, action: PayloadAction<NetworkView>) {
      state.networkView = action.payload;
    },
    /** Launch a dApp into the in-window app-view (mobile-OS app-open). */
    setOpenApp(state, action: PayloadAction<OpenApp>) {
      state.openApp = action.payload;
    },
    /** Close the in-window app-view (back to the launcher). */
    closeApp(state) {
      state.openApp = null;
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
      state.networkView = route.networkView;
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

export const { setTab, setWalletView, setNetworkView, setOpenApp, closeApp, setLocale, setAdvanced, routeFromHash, settingsHydrated } =
  uiSlice.actions;
export const uiReducer = uiSlice.reducer;

export { DEFAULT_TAB, DEFAULT_WALLET_VIEW, DEFAULT_NETWORK_VIEW };
