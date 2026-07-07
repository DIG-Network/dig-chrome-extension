import { resolveCatMeta, type CatMetaMap } from '@/features/wallet/catMetadata';
import { formatBaseUnits, shortenAddress } from '@/lib/wallet-view';
import { DIG_ASSET_ID, spaceScanCoinUrl } from '@/lib/links';
import type { ActivityEvent } from '@/offscreen/activity';

/** A display row for the Activity list — the last, cheap formatting step over an indexed event. */
export interface ActivityRow {
  id: string;
  kind: 'sent' | 'received' | 'trade';
  ticker: string;
  amountLabel: string;
  /** Shortened counterparty address (sent), else null. */
  counterparty: string | null;
  spaceScanUrl: string | null;
  timestamp: number;
  height: number;
  coinId: string;
}

const strip0x = (h: string): string => h.replace(/^0x/i, '').toLowerCase();
const DIG_ID = strip0x(DIG_ASSET_ID);

/** Resolve one activity-event asset id to its display ticker + amount decimals (#151). */
function tickerAndDecimals(asset: string, registry?: CatMetaMap | null): { ticker: string; decimals: number } {
  if (asset === 'XCH') return { ticker: 'XCH', decimals: 12 };
  const id = strip0x(asset);
  // $DIG keeps its canonical branding (matches custodyAssetBalances) even if the registry names it
  // something else; every other CAT resolves through the SAME dexie-backed registry the Assets list
  // uses, so Activity never shows a generic ticker for a token the registry actually knows.
  if (id === DIG_ID) return { ticker: '$DIG', decimals: 3 };
  const meta = resolveCatMeta(id, registry);
  return { ticker: meta.ticker, decimals: meta.decimals };
}

/**
 * Format indexed {@link ActivityEvent}s into display rows: resolve each asset to its REAL ticker +
 * decimals via the dexie CAT registry (XCH and $DIG are special-cased; #151 — previously this used a
 * hardcoded 'CAT'/short-id ticker for every non-$DIG asset, never consulting the registry, so every
 * CAT transaction showed a generic ticker even for well-known tokens), render the amount, shorten the
 * counterparty, and attach a SpaceScan link. An unresolvable/not-yet-loaded registry degrades
 * gracefully to {@link resolveCatMeta}'s short-form ticker — never a blank or broken row. Pure — the
 * indexer did the hard work; `registry` is the same {@link CatMetaMap} `custodyAssetBalances` uses.
 */
export function activityRows(events: ActivityEvent[], registry?: CatMetaMap | null): ActivityRow[] {
  return events.map((e) => {
    const { ticker, decimals } = tickerAndDecimals(e.asset, registry);
    return {
      id: e.id,
      kind: e.kind,
      ticker,
      amountLabel: formatBaseUnits(Number(e.amount), decimals),
      counterparty: e.counterparty ? shortenAddress(e.counterparty) : null,
      spaceScanUrl: spaceScanCoinUrl(e.coinId),
      timestamp: e.timestamp,
      height: e.height,
      coinId: e.coinId,
    };
  });
}
