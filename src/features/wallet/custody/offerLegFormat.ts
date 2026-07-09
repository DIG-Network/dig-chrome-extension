import { formatBaseUnits } from '@/lib/wallet-view';
import type { WireOfferAsset } from '@/offscreen/vault';

const XCH_DECIMALS = 12;

/** Format one wire offer leg as "<amount> <ticker>" — shared by {@link TradePanel}'s take-side
 * review and {@link OffersPanel}'s made-offer rows (#101), so both surfaces render a leg identically.
 * XCH decimals for XCH; a 3-dp CAT default (no registry lookup here — see the ticker truncation
 * note below); an offered NFT leg (#94) by its launcher id's first bytes. */
export function legLabel(leg: { asset: WireOfferAsset; amount: string }): string {
  if (leg.asset.kind === 'xch') return `${formatBaseUnits(Number(leg.amount), XCH_DECIMALS)} XCH`;
  if (leg.asset.kind === 'nft') return `NFT ${leg.asset.launcherId.slice(0, 6)}…`;
  return `${formatBaseUnits(Number(leg.amount), 3)} ${leg.asset.assetId.slice(0, 6)}…`;
}
