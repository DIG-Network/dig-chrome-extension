/**
 * `wallet` feature's curated cross-feature surface (§6.4 — deep imports discouraged).
 *
 * Other features (home, collectibles, identity, …) import wallet symbols from HERE,
 * never via a deep `@/features/wallet/<submodule>` path. Wallet-internal code keeps
 * its own deep relative imports (this barrel is for CROSS-feature consumers only —
 * routing internal imports through it would risk import cycles).
 *
 * Extend deliberately: add a symbol here only once a second feature needs it.
 */

// Custody RTK Query hook (send-status polling used from NFT/DID/mint flows)
export { useLazySendStatusQuery } from './custodyApi';

// Home dashboard RTK Query hooks
export { useGetCustodyBalancesQuery, useGetLockStateQuery, useGetCustodyActivityQuery } from './custodyApi';
export { useGetCatRegistryQuery } from './catMetadataApi';
export { useGetPricesQuery } from './priceApi';

// Custody balance/activity helpers
export { custodyAssetBalances } from './custody/balances';
export { activityRows } from './custody/activityRows';
export type { ActivityRow } from './custody/activityRows';

// Portfolio + fiat/price valuation helpers
export { pickHeroBalance } from './portfolio';
export { assetUsdValue } from './portfolioValue';
export { resolveFiatValue } from './fiatValue';
export { useFiatPreference } from './useFiatPreference';

// Balance-unit (USD/XCH toggle) display helpers
export {
  BALANCE_UNIT_STORAGE_KEY,
  DEFAULT_BALANCE_UNIT,
  isBalanceUnit,
  toggleBalanceUnit,
  heroBalanceDisplay,
} from './balanceUnit';
export type { BalanceUnit, SlotDisplay } from './balanceUnit';

// Fiat-currency preference storage key
export { FIAT_CURRENCY_STORAGE_KEY } from './fiatCurrency';

// FX-rate fetch endpoint
export { COINGECKO_FX_URL } from './fxRates';

// Wallet slice actions/selectors (active-derivation-index used by identity flows)
export { setActiveDerivationIndex, selectActiveDerivationIndex } from './walletSlice';
