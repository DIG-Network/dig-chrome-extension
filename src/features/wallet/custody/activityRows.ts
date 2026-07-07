import { resolveCatMeta, type CatMetaMap } from '@/features/wallet/catMetadata';
import { formatBaseUnits, shortenAddress } from '@/lib/wallet-view';
import { DIG_ASSET_ID, spaceScanCoinUrl } from '@/lib/links';
import type { ActivityKind, ActivityStatus, LocalActivityEntry } from '@/lib/activity-log';

/** A display row for the Activity list — the last, cheap formatting step over a local log entry
 * (#154). Unlike the retired on-chain reconstruction this replaces, a row has no block `height` —
 * `status` (`pending`/`confirmed`) is the entry's lifecycle signal instead. */
export interface ActivityRow {
  id: string;
  kind: ActivityKind;
  ticker: string;
  amountLabel: string;
  /** Shortened counterparty address (sent/did/trade-with-a-known-recipient), else null. */
  counterparty: string | null;
  /** Only set once `status === 'confirmed'` — a pending spend's coin id may not resolve yet. */
  spaceScanUrl: string | null;
  timestamp: number;
  status: ActivityStatus;
  coinId: string | null;
}

const strip0x = (h: string): string => h.replace(/^0x/i, '').toLowerCase();
const DIG_ID = strip0x(DIG_ASSET_ID);
/** Synthetic (non-fungible/non-CAT) asset labels a #154 entry may carry — never run through the CAT
 * registry (an NFT/DID has no TAIL id, no decimals; showing amount ÷ CAT-default decimals would
 * render a nonsensical fraction for a whole-number NFT/DID spend). */
const NON_TOKEN_ASSETS = new Set(['NFT', 'DID']);

/** Resolve one activity-entry asset id to its display ticker + amount decimals (#151). */
function tickerAndDecimals(asset: string, registry?: CatMetaMap | null): { ticker: string; decimals: number } {
  if (asset === 'XCH') return { ticker: 'XCH', decimals: 12 };
  if (NON_TOKEN_ASSETS.has(asset)) return { ticker: asset, decimals: 0 };
  const id = strip0x(asset);
  // $DIG keeps its canonical branding (matches custodyAssetBalances) even if the registry names it
  // something else; every other CAT resolves through the SAME dexie-backed registry the Assets list
  // uses, so Activity never shows a generic ticker for a token the registry actually knows.
  if (id === DIG_ID) return { ticker: '$DIG', decimals: 3 };
  const meta = resolveCatMeta(id, registry);
  return { ticker: meta.ticker, decimals: meta.decimals };
}

/**
 * Format LOCAL activity-log {@link LocalActivityEntry}s (#154 — the extension's own record of an
 * action it took / a balance-delta receive, NOT an on-chain reconstruction) into display rows:
 * resolve each asset to its REAL ticker + decimals via the dexie CAT registry (XCH, $DIG, and the
 * synthetic NFT/DID labels are special-cased; #151 — a held CAT resolves through the SAME registry
 * the Assets list uses, so Activity never shows a generic ticker for a token the registry actually
 * knows), render the amount, shorten the counterparty, and attach a SpaceScan link — but ONLY once
 * `status === 'confirmed'` (a still-`pending` coin may not resolve on the block explorer yet). An
 * unresolvable/not-yet-loaded registry degrades gracefully to {@link resolveCatMeta}'s short-form
 * ticker — never a blank or broken row. Pure; `registry` is the same {@link CatMetaMap}
 * `custodyAssetBalances` uses.
 */
export function activityRows(entries: LocalActivityEntry[], registry?: CatMetaMap | null): ActivityRow[] {
  return entries.map((e) => {
    const { ticker, decimals } = tickerAndDecimals(e.asset, registry);
    return {
      id: e.id,
      kind: e.kind,
      ticker,
      amountLabel: formatBaseUnits(Number(e.amount), decimals),
      counterparty: e.counterparty ? shortenAddress(e.counterparty) : null,
      spaceScanUrl: e.status === 'confirmed' && e.coinId ? spaceScanCoinUrl(e.coinId) : null,
      timestamp: e.timestamp,
      status: e.status,
      coinId: e.coinId,
    };
  });
}
