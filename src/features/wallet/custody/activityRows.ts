import { assetDescriptors } from '#shared/wallet-assets.mjs';
import { formatBaseUnits, shortenAddress } from '#shared/wallet-view.mjs';
import { spaceScanCoinUrl } from '#shared/links.mjs';
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

/**
 * Format indexed {@link ActivityEvent}s into display rows: resolve each asset to its ticker +
 * decimals (XCH, $DIG, watched CATs; unknown CATs → a short id + CAT decimals), render the amount,
 * shorten the counterparty, and attach a SpaceScan link. Pure — the indexer did the hard work.
 */
export function activityRows(events: ActivityEvent[], watchedCats: unknown): ActivityRow[] {
  const byAsset = new Map<string, { ticker: string; decimals: number }>();
  byAsset.set('xch', { ticker: 'XCH', decimals: 12 });
  for (const d of assetDescriptors(watchedCats)) {
    if (d.assetId) byAsset.set(strip0x(d.assetId), { ticker: d.ticker, decimals: d.decimals });
  }
  return events.map((e) => {
    const key = e.asset === 'XCH' ? 'xch' : strip0x(e.asset);
    const meta = byAsset.get(key) ?? { ticker: `CAT ${key.slice(0, 6)}`, decimals: 3 };
    return {
      id: e.id,
      kind: e.kind,
      ticker: meta.ticker,
      amountLabel: formatBaseUnits(Number(e.amount), meta.decimals),
      counterparty: e.counterparty ? shortenAddress(e.counterparty) : null,
      spaceScanUrl: spaceScanCoinUrl(e.coinId),
      timestamp: e.timestamp,
      height: e.height,
      coinId: e.coinId,
    };
  });
}
