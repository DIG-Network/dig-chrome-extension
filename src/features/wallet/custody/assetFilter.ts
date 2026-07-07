/**
 * Asset-list filter + autocomplete (#167) — a pure VIEW-layer companion to `assetOrder`: given the
 * already-resolved `AssetBalance[]` (from `custodyAssetBalances`), narrow the list live by ticker or
 * display name, and surface autocomplete candidates while typing. Does NOT touch the scan/derivation
 * — filtering never hides a coin, only the row.
 */

import type { AssetBalance } from '@/features/wallet/assetTypes';
import type { CatMetaMap } from '@/features/wallet/catMetadata';

/** Case-insensitive substring match against a row's ticker or display name. A blank query matches everything. */
export function matchesAssetQuery(row: AssetBalance, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return row.descriptor.ticker.toLowerCase().includes(q) || row.descriptor.name.toLowerCase().includes(q);
}

/**
 * Filter `rows` live by ticker/name (#167). A blank query returns `rows` BY REFERENCE (unchanged),
 * so a caller doing `useMemo`/re-render diffing skips work when the filter is empty.
 */
export function filterAssetsByQuery(rows: AssetBalance[], query: string): AssetBalance[] {
  if (!query.trim()) return rows;
  return rows.filter((r) => matchesAssetQuery(r, query));
}

/** One autocomplete candidate: a ticker + its display name. */
export interface AssetSuggestion {
  ticker: string;
  name: string;
}

/** Keep the suggestion list short — a handful of candidates is plenty for a filter box. */
const MAX_SUGGESTIONS = 8;

/**
 * Autocomplete candidates for the filter field, sourced from HELD assets (so the exact spelling of
 * what you already own is always offered) plus the full known-CAT registry (so a query for a
 * recognized name/ticker you don't currently hold still autocompletes — filtering then honestly
 * shows the empty state, never a silent no-op). Deduped by ticker (held wins over a registry
 * duplicate), ranked prefix matches before mere substring matches, capped to `MAX_SUGGESTIONS`.
 */
export function assetAutocompleteSuggestions(rows: AssetBalance[], registry: CatMetaMap | null | undefined, query: string): AssetSuggestion[] {
  const byTicker = new Map<string, AssetSuggestion>();
  for (const r of rows) {
    if (!byTicker.has(r.descriptor.ticker)) byTicker.set(r.descriptor.ticker, { ticker: r.descriptor.ticker, name: r.descriptor.name });
  }
  for (const meta of Object.values(registry ?? {})) {
    if (!byTicker.has(meta.ticker)) byTicker.set(meta.ticker, { ticker: meta.ticker, name: meta.name });
  }
  const all = [...byTicker.values()];

  const q = query.trim().toLowerCase();
  if (!q) return all.slice(0, MAX_SUGGESTIONS);

  const ranked: { suggestion: AssetSuggestion; rank: number }[] = [];
  for (const suggestion of all) {
    const ticker = suggestion.ticker.toLowerCase();
    const name = suggestion.name.toLowerCase();
    if (ticker.startsWith(q) || name.startsWith(q)) ranked.push({ suggestion, rank: 0 });
    else if (ticker.includes(q) || name.includes(q)) ranked.push({ suggestion, rank: 1 });
  }
  ranked.sort((a, b) => a.rank - b.rank);
  return ranked.slice(0, MAX_SUGGESTIONS).map((r) => r.suggestion);
}
