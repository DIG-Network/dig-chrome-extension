/**
 * USD conversion for the dApp approval window's fiat equivalents (#77 P2-1) — turns a decoded
 * spend's on-chain amount (mojos for native XCH, base units for a CAT) into a USD number using the
 * SAME `PriceMap` the wallet's own balances view prices from (`@/features/wallet/priceApi`). No
 * DOM / chrome.* / intl dependency, same idiom as `portfolioValue.ts`: a caller only invokes this
 * once it has a `PriceMap`, and renders `null` as "no fiat equivalent yet" (never a fabricated $0)
 * — a price outage never blocks or misleads the approval flow; the on-chain amount above is always
 * the authoritative figure the user is approving.
 */

import type { PriceMap } from '@/features/wallet/priceTypes';
import { normalizeCatId } from '@/lib/wallet-assets';

/** Native-XCH decimals (mojos per XCH). */
const XCH_DECIMALS = 12;

/** USD value of a native-XCH amount given in mojos, or `null` when the XCH price isn't known yet
 * or `mojos` isn't a finite number. */
export function xchMojosToUsd(mojos: string, prices: PriceMap): number | null {
  const price = prices.xch;
  if (!price) return null;
  const n = Number(mojos);
  if (!Number.isFinite(n)) return null;
  return (n / 10 ** XCH_DECIMALS) * price.usd;
}

/** USD value of a CAT amount given in base units, or `null` when that CAT's price isn't known yet
 * or `amountBaseUnits` isn't a finite number. `decimals` is the CAT's resolved base-unit scale
 * (`resolveCatMeta(...).decimals` — `CAT_DECIMALS` for an unknown token). */
export function catBaseUnitsToUsd(assetId: string, amountBaseUnits: string, decimals: number, prices: PriceMap): number | null {
  const key = normalizeCatId(assetId);
  const price = key ? prices[key] : undefined;
  if (!price) return null;
  const n = Number(amountBaseUnits);
  if (!Number.isFinite(n)) return null;
  return (n / 10 ** decimals) * price.usd;
}
