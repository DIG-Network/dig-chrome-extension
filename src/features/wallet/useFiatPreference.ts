import { useStorageValue } from '@/lib/useStorageValue';
import { useGetFxRatesQuery } from '@/features/wallet/priceApi';
import { DEFAULT_FIAT_CURRENCY, FIAT_CURRENCY_STORAGE_KEY, isFiatCode, type FiatCode } from '@/features/wallet/fiatCurrency';

/**
 * The fiat-currency display preference (#112), read + persisted the same idiom as `balanceUnit.ts`'s
 * `BALANCE_UNIT_STORAGE_KEY` — every $-value surface (the wallet Assets list, the portfolio hero, the
 * Home balance widget) reads through this ONE hook so the choice is consistent everywhere (§6.1).
 *
 * The exchange-rate query only fires once the user picks a non-USD currency (`skip` when `fiat ===
 * 'usd'` or the caller passes `skipFx`, e.g. while the wallet is locked) — USD never needs a network
 * round-trip since it's the price feed's own anchor currency.
 */
export function useFiatPreference(skipFx = false) {
  const [stored, setStored] = useStorageValue<FiatCode>(FIAT_CURRENCY_STORAGE_KEY, DEFAULT_FIAT_CURRENCY);
  const fiat = isFiatCode(stored) ? stored : DEFAULT_FIAT_CURRENCY;
  const fx = useGetFxRatesQuery(undefined, { skip: skipFx || fiat === 'usd' });
  return { fiat, setFiat: setStored, fx };
}
