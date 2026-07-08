import { resolveCatMeta, type CatMetaMap } from '@/features/wallet/catMetadata';
import { formatBaseUnits, shortenAddress } from '@/lib/wallet-view';
import { DIG_ASSET_ID, spaceScanCoinUrl, spaceScanAddressUrl, spaceScanTokenUrl } from '@/lib/links';
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
  /** SpaceScan address-page link for the counterparty's FULL (unshortened) address (#113/#114), or
   * null when there is no counterparty. Unlike `spaceScanUrl` this is NOT gated on `confirmed` — an
   * address is valid to look up regardless of the spend's own confirmation state. */
  counterpartyUrl: string | null;
  /** Only set once `status === 'confirmed'` — a pending spend's coin id may not resolve yet. */
  spaceScanUrl: string | null;
  /** SpaceScan token-page link for a CAT-class asset (#114) — null for XCH and the synthetic
   * NFT/DID labels, which have no CAT token page. */
  tokenUrl: string | null;
  timestamp: number;
  status: ActivityStatus;
  coinId: string | null;
  /** #113 — the network fee paid, formatted in XCH (fees are always XCH regardless of the asset
   * transferred), or null when the entry didn't record one (never fabricated). */
  feeLabel: string | null;
  /** #113 — an optional memo/note attached to the entry, or null when none was set. */
  memo: string | null;
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
    // A CAT-class asset (excludes XCH + the synthetic NFT/DID labels) has a SpaceScan token page;
    // $DIG counts too — it's a CAT under the hood, just with canonical branding (#114).
    const isCatClass = e.asset !== 'XCH' && !NON_TOKEN_ASSETS.has(e.asset);
    return {
      id: e.id,
      kind: e.kind,
      ticker,
      amountLabel: formatBaseUnits(Number(e.amount), decimals),
      counterparty: e.counterparty ? shortenAddress(e.counterparty) : null,
      counterpartyUrl: e.counterparty ? spaceScanAddressUrl(e.counterparty) : null,
      spaceScanUrl: e.status === 'confirmed' && e.coinId ? spaceScanCoinUrl(e.coinId) : null,
      tokenUrl: isCatClass ? spaceScanTokenUrl(e.asset) : null,
      timestamp: e.timestamp,
      status: e.status,
      coinId: e.coinId,
      // Fees are always paid in XCH mojos regardless of the transferred asset — format at XCH's 12
      // decimals, never the transferred asset's own `decimals` (#113).
      feeLabel: e.fee != null ? formatBaseUnits(e.fee, 'xch') : null,
      memo: e.memo ?? null,
    };
  });
}
