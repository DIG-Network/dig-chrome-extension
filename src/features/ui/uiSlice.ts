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
import { DEFAULT_THEME_MODE, isThemeMode, type ThemeMode } from '@/lib/theme';
import { DEFAULT_NETWORK_ID, isNetworkId, type NetworkId } from '@/lib/network';
import {
  DEFAULT_CHAIN_SOURCE_MODE,
  isChainSourceMode,
  CHAIN_SOURCE_MODE_KEY,
  CHAIN_SOURCE_URL_KEY,
  type ChainSourceMode,
} from '@/lib/wallet-source';

/** Cross-document client UI state (route + prefs), kept in sync via the storage bridge. */
export interface UiState {
  tab: Tab;
  walletView: WalletView;
  /** The Network screen's active sub-view (resolver | shield | control). */
  networkView: NetworkView;
  /** Active UI locale (persisted to `wallet.settings.locale`). */
  locale: string;
  /** Active theme mode (#111, persisted to `wallet.settings.theme`); `system` follows the OS. */
  theme: ThemeMode;
  /** Active chain network (#108, persisted to `wallet.settings.network`). Mainnet is real funds. */
  network: NetworkId;
  /** Wallet-data source mode (#217, persisted to `wallet.settings.chainSourceMode`). Default auto. */
  chainSource: ChainSourceMode;
  /** The node RPC base URL used when `chainSource === 'custom'` (#217). */
  chainSourceUrl: string;
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
  theme?: string;
  network?: string;
  chainSourceMode?: string;
  chainSourceUrl?: string;
}

function initialState(): UiState {
  const route = resolveRoute(typeof location !== 'undefined' ? location.hash : '');
  return {
    tab: route.tab,
    walletView: route.walletView,
    networkView: route.networkView,
    locale: DEFAULT_LOCALE,
    theme: DEFAULT_THEME_MODE,
    network: DEFAULT_NETWORK_ID,
    chainSource: DEFAULT_CHAIN_SOURCE_MODE,
    chainSourceUrl: '',
    openApp: null,
  };
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
    /** Set the active theme mode (#111), ignoring an unrecognized value (falls back to system). */
    setTheme(state, action: PayloadAction<ThemeMode>) {
      state.theme = isThemeMode(action.payload) ? action.payload : DEFAULT_THEME_MODE;
    },
    /** Set the active chain network (#108), ignoring an unrecognized value (falls back to mainnet). */
    setChainNetwork(state, action: PayloadAction<NetworkId>) {
      state.network = isNetworkId(action.payload) ? action.payload : DEFAULT_NETWORK_ID;
    },
    /** Set the wallet-data source (#217): mode (+ custom url). Unknown mode → 'auto'. */
    setChainSource(state, action: PayloadAction<{ mode: ChainSourceMode; customUrl?: string }>) {
      state.chainSource = isChainSourceMode(action.payload.mode) ? action.payload.mode : DEFAULT_CHAIN_SOURCE_MODE;
      if (action.payload.customUrl !== undefined) state.chainSourceUrl = action.payload.customUrl;
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
      if (isThemeMode(s.theme)) state.theme = s.theme;
      if (isNetworkId(s.network)) state.network = s.network;
      if (isChainSourceMode(s[CHAIN_SOURCE_MODE_KEY])) state.chainSource = s[CHAIN_SOURCE_MODE_KEY];
      if (typeof s[CHAIN_SOURCE_URL_KEY] === 'string') state.chainSourceUrl = s[CHAIN_SOURCE_URL_KEY];
    },
  },
});

export const {
  setTab,
  setWalletView,
  setNetworkView,
  setOpenApp,
  closeApp,
  setLocale,
  setTheme,
  setChainNetwork,
  setChainSource,
  routeFromHash,
  settingsHydrated,
} = uiSlice.actions;
export const uiReducer = uiSlice.reducer;

export { DEFAULT_TAB, DEFAULT_WALLET_VIEW, DEFAULT_NETWORK_VIEW };
