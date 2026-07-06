import { assetDescriptors } from '@/lib/wallet-assets';
import { formatBaseUnits } from '@/lib/wallet-view';
import type { AssetBalance } from '@/features/wallet/assetTypes';
import type { CustodyBalances } from '@/features/wallet/custodyApi';

const strip0x = (h: string | null | undefined): string => String(h ?? '').replace(/^0x/i, '').toLowerCase();

/**
 * Map a self-custody balance scan → the shared `AssetBalance[]` the wallet UI renders (XCH + $DIG +
 * watched CATs). XCH comes from `scan.xch` (mojos); each CAT from `scan.cats[tail]` (base units),
 * matched to its descriptor by normalized asset id. A missing entry renders as `null` (never a
 * false 0). Pure — the network scan happens in the offscreen vault; this is the last formatting step.
 */
export function custodyAssetBalances(
  scan: CustodyBalances['balances'] | undefined,
  watchedCats: unknown,
): AssetBalance[] {
  const cats = scan?.cats ?? {};
  // Normalize the scanned CAT keys once for lookup.
  const byTail: Record<string, number> = {};
  for (const [k, v] of Object.entries(cats)) byTail[strip0x(k)] = v;

  return assetDescriptors(watchedCats).map((d) => {
    const raw = d.key === 'xch' ? scan?.xch : d.assetId != null ? byTail[strip0x(d.assetId)] : undefined;
    const balance = typeof raw === 'number' ? raw : null;
    return { descriptor: d, balance, label: formatBaseUnits(balance, d.decimals) };
  });
}
