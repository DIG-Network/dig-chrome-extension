/**
 * Wallet asset registry + tracked-CAT list — the pure model behind the Assets view and the Send
 * asset picker (no DOM / chrome.*, so it is unit-tested and the renderer stays thin glue).
 *
 * Mirrors the native DIG Browser wallet's "Cash & Tokens" (dig-wallet ui.html): a built-in
 * registry for XCH + $DIG, plus a user-tracked list of extra CATs added by their 32-byte TAIL
 * (asset id). The extension can't run a wallet, so every balance is Sage's wallet-wide AGGREGATE
 * (across all HD addresses) via a single `chip0002_getAssetBalance` per asset — there is no
 * client-side address enumeration.
 *
 * There is no on-chain CAT metadata resolver in scope, so a tracked CAT uses the Chia CAT
 * convention of 3 decimals (same as $DIG); the user may give it a display name.
 */

import { DIG_ASSET_ID } from './links';

/** XCH — the native coin (1 XCH = 1e12 mojos). `assetId:null` selects XCH in Sage calls. */
export const XCH_META = Object.freeze({ key: 'xch', ticker: 'XCH', name: 'Chia', decimals: 12, assetId: null });

/** $DIG — the DIG CAT (1 $DIG = 1000 base units, 3 decimals), pinned to its real TAIL. */
export const DIG_META = Object.freeze({ key: 'dig', ticker: '$DIG', name: 'DIG', decimals: 3, assetId: DIG_ASSET_ID });

/** Chia CAT convention: 3 decimals. Used for every tracked (non-DIG) CAT. */
export const CAT_DECIMALS = 3;

/**
 * Normalise a CAT asset id (TAIL hash): strip a leading `0x` and surrounding whitespace,
 * lowercase, and require exactly 64 hex chars. Returns the canonical id or `null` if invalid.
 */
/** One tracked-CAT entry: its 64-hex TAIL id + an optional display name. */
export interface WatchedCat {
  assetId: string;
  name: string;
}
/** An ordered asset row the Assets view shows + queries a balance for. */
export interface AssetDescriptor {
  key: 'xch' | 'dig' | 'cat';
  ticker: string;
  name: string;
  decimals: number;
  assetId: string | null;
  type: 'cat' | null;
}

export function normalizeCatId(raw: unknown): string | null {
  if (raw == null) return null;
  let s = String(raw).trim().toLowerCase();
  if (s.startsWith('0x')) s = s.slice(2);
  return /^[0-9a-f]{64}$/.test(s) ? s : null;
}

/**
 * Parse the persisted tracked-CAT list (chrome.storage.local `wallet.watchedCats`) into a clean
 * `[{assetId, name}]`, tolerating junk: non-arrays → `[]`, bare-string ids, and entries with a
 * bad/missing id are dropped. Names are coerced to a trimmed string.
 */
export function parseWatchedCats(stored: unknown): WatchedCat[] {
  if (!Array.isArray(stored)) return [];
  const out = [];
  for (const entry of stored) {
    if (typeof entry === 'string') {
      const id = normalizeCatId(entry);
      if (id) out.push({ assetId: id, name: '' });
      continue;
    }
    if (entry && typeof entry === 'object') {
      const id = normalizeCatId(entry.assetId);
      if (id) out.push({ assetId: id, name: String(entry.name || '').trim() });
    }
  }
  return out;
}

/**
 * Add a tracked CAT to `list`. Validates the id, refuses XCH/$DIG (built-in) and duplicates.
 * Returns `{ ok, list, error }` — `list` is a NEW array on success, the original otherwise.
 */
export function addWatchedCat(list: unknown, rawId: string, name = ''): { ok: boolean; list: WatchedCat[]; error: string | null } {
  const current = parseWatchedCats(list);
  const id = normalizeCatId(rawId);
  if (!id) return { ok: false, list: current, error: 'Enter a valid 32-byte asset id (0x… TAIL).' };
  if (id === normalizeCatId(DIG_ASSET_ID)) {
    return { ok: false, list: current, error: '$DIG is already shown.' };
  }
  if (current.some((c) => c.assetId === id)) {
    return { ok: false, list: current, error: 'That token is already tracked.' };
  }
  return { ok: true, list: [...current, { assetId: id, name: String(name || '').trim() }], error: null };
}

/** Remove a tracked CAT by asset id (tolerating 0x/case); returns a NEW list (no-op if absent). */
export function removeWatchedCat(list: unknown, rawId: string): WatchedCat[] {
  const id = normalizeCatId(rawId);
  const current = parseWatchedCats(list);
  if (!id) return current;
  return current.filter((c) => c.assetId !== id);
}

/** A tracked CAT's display name, falling back to a shortened TAIL. */
function catDisplayName(cat: { name?: string; assetId: string }): string {
  if (cat.name) return cat.name;
  return `Token ${cat.assetId.slice(0, 6)}…${cat.assetId.slice(-4)}`;
}

/**
 * The ordered asset descriptors the Assets view shows (and queries a balance for): XCH, then
 * $DIG, then each tracked CAT. Each descriptor carries the ticker/name/decimals + the
 * `{type, assetId}` a `chip0002_getAssetBalance` call needs.
 */
export function assetDescriptors(watchedCats: unknown): AssetDescriptor[] {
  const cats: AssetDescriptor[] = parseWatchedCats(watchedCats).map((c) => ({
    key: 'cat',
    ticker: 'CAT',
    name: catDisplayName(c),
    decimals: CAT_DECIMALS,
    assetId: c.assetId,
    type: 'cat',
  }));
  return [
    { key: 'xch', ticker: XCH_META.ticker, name: XCH_META.name, decimals: 12, assetId: null, type: null },
    { key: 'dig', ticker: DIG_META.ticker, name: DIG_META.name, decimals: 3, assetId: DIG_META.assetId, type: 'cat' },
    ...cats,
  ];
}

/** Options for the Send asset `<select>`: XCH, $DIG, then each tracked CAT (value = its TAIL). */
export function sendAssetOptions(watchedCats: unknown): Array<{ value: string; label: string }> {
  const cats = parseWatchedCats(watchedCats).map((c) => ({ value: c.assetId, label: catDisplayName(c) }));
  return [
    { value: 'xch', label: 'XCH' },
    { value: 'dig', label: '$DIG' },
    ...cats,
  ];
}

/**
 * Resolve a Send picker `value` to the `chia_send` asset params + display decimals/ticker:
 *   - `'xch'` → `{ type:null, assetId:null, decimals:12 }`
 *   - `'dig'` → `{ type:'cat', assetId:DIG, decimals:3 }`
 *   - a 64-hex TAIL that is tracked → `{ type:'cat', assetId, decimals:3 }`
 * An unknown value returns `null` (the renderer surfaces an error / falls back to XCH).
 */
export function resolveSendAsset(value: string, watchedCats: unknown): { type: 'cat' | null; assetId: string | null; decimals: number; ticker: string } | null {
  if (value === 'xch') return { type: null, assetId: null, decimals: 12, ticker: 'XCH' };
  if (value === 'dig') return { type: 'cat', assetId: DIG_META.assetId, decimals: 3, ticker: '$DIG' };
  const id = normalizeCatId(value);
  if (!id) return null;
  const cat = parseWatchedCats(watchedCats).find((c) => c.assetId === id);
  if (!cat) return null;
  return { type: 'cat', assetId: id, decimals: CAT_DECIMALS, ticker: catDisplayName(cat) };
}
