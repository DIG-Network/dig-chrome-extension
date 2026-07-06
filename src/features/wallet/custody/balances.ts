import { XCH_META, DIG_META, catRowTails, parseWatchedCats } from '@/lib/wallet-assets';
import { DIG_ASSET_ID } from '@/lib/links';
import { formatBaseUnits } from '@/lib/wallet-view';
import { resolveCatMeta, type CatMetaMap } from '@/features/wallet/catMetadata';
import type { AssetDescriptor } from '@/lib/wallet-assets';
import type { AssetBalance } from '@/features/wallet/assetTypes';
import type { CustodyBalances } from '@/features/wallet/custodyApi';

const strip0x = (h: string | null | undefined): string => String(h ?? '').replace(/^0x/i, '').toLowerCase();
const DIG_ID = strip0x(DIG_ASSET_ID);

/** Options for the discovery-aware token list: the resolved CAT registry + the user's hidden set. */
export interface AssetBalanceOpts {
  /** dexie CAT registry (name/ticker/icon/decimals per TAIL); null/absent → short-form fallback. */
  registry?: CatMetaMap | null;
  /** Hidden CAT tails to suppress from the list (#87/#95 manage-tokens). */
  hidden?: unknown;
}

/**
 * Map a self-custody balance scan → the shared `AssetBalance[]` the wallet UI renders. The CAT set is
 * AUTO-DISCOVERED (#87): every TAIL present in `scan.cats` becomes a row (plus any manually-watched
 * TAIL), enriched with human name/ticker/icon/decimals from the CAT registry and MINUS the user's
 * hidden set. Order: XCH, then the built-in $DIG row (canonical branding; the registry only lends its
 * icon), then the remaining discovered/watched CATs. A missing balance renders as `null` (never a
 * false 0). Pure — the network scan + registry fetch happen upstream; this is the formatting step.
 */
export function custodyAssetBalances(
  scan: CustodyBalances['balances'] | undefined,
  watchedCats: unknown,
  opts: AssetBalanceOpts = {},
): AssetBalance[] {
  const cats = scan?.cats ?? {};
  const registry = opts.registry ?? null;
  // Normalize the scanned CAT keys once for lookup.
  const byTail: Record<string, number> = {};
  for (const [k, v] of Object.entries(cats)) byTail[strip0x(k)] = v;

  const descriptors: AssetDescriptor[] = [
    { key: 'xch', ticker: XCH_META.ticker, name: XCH_META.name, decimals: 12, assetId: null, type: null, iconUrl: null },
    // $DIG is a built-in row with fixed branding; the registry contributes only its icon.
    { key: 'dig', ticker: DIG_META.ticker, name: DIG_META.name, decimals: 3, assetId: DIG_META.assetId, type: 'cat', iconUrl: registry?.[DIG_ID]?.iconUrl ?? null },
  ];

  // Discovered + watched CATs (held TAILs from the scan ∪ the manual watch list), minus hidden/DIG.
  const userNameByTail = new Map(parseWatchedCats(watchedCats).map((c) => [c.assetId, c.name]));
  for (const tail of catRowTails(Object.keys(cats), watchedCats, opts.hidden)) {
    const meta = resolveCatMeta(tail, registry);
    const userName = userNameByTail.get(tail);
    descriptors.push({
      key: 'cat',
      ticker: meta.ticker,
      name: userName && userName.trim() ? userName.trim() : meta.name,
      decimals: meta.decimals,
      assetId: tail,
      type: 'cat',
      iconUrl: meta.iconUrl,
    });
  }

  return descriptors.map((d) => {
    const raw = d.key === 'xch' ? scan?.xch : d.assetId != null ? byTail[strip0x(d.assetId)] : undefined;
    const balance = typeof raw === 'number' ? raw : null;
    return { descriptor: d, balance, label: formatBaseUnits(balance, d.decimals) };
  });
}
