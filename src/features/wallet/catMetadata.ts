/**
 * CAT token metadata — resolve a TAIL (asset id) → a human name, ticker, icon, and decimals, from a
 * public CAT registry so auto-discovered tokens (#87) show a real identity instead of a raw hash.
 *
 * Source: dexie's swap-token registry `GET https://api.dexie.space/v1/swap/tokens` →
 * `{ success, tokens: [{ id, name, code, denom, icon }] }` (~700 CATs; `id` is the 64-hex TAIL,
 * `code` the ticker, `denom` the base-unit scale → decimals, `icon` a `https://icons.dexie.space/…`
 * URL). dexie is already the #86 price host (CSP `connect-src` allows `api.dexie.space`; icons need
 * `img-src https://icons.dexie.space`). This registry changes slowly, so its RTK Query slice caches
 * it with a LONG TTL (`catMetadataApi`) — unlike the 120 s price TTL.
 *
 * All parsing is pure + tolerant (a malformed entry is dropped, never throws). When a TAIL is absent
 * from the registry (or the fetch fails entirely), {@link resolveCatMeta} degrades gracefully to a
 * short-form TAIL name + a generic ticker + no icon — the wallet still lists the holding.
 */

import { normalizeCatId } from '@/lib/wallet-assets';

/** dexie's swap-token registry endpoint (public, CSP-allowed via the #86 price host). */
export const DEXIE_TOKENS_URL = 'https://api.dexie.space/v1/swap/tokens';

/** Chia CAT convention: 3 decimals (denom 1000). Used when the registry omits/!=known a denom. */
export const CAT_DECIMALS = 3;

/** Resolved metadata for one CAT (all display-ready). */
export interface CatMeta {
  /** Human name (e.g. "Spacebucks"), or a short-form TAIL when unknown. */
  name: string;
  /** Ticker/code (e.g. "SBX"), or "CAT" when unknown. */
  ticker: string;
  /** Absolute icon URL (dexie CDN), or null when unknown → the UI shows a monogram. */
  iconUrl: string | null;
  /** Base-unit decimals derived from the registry `denom` (1000 → 3), else the CAT default. */
  decimals: number;
}

/** TAIL (lowercased 64-hex) → {@link CatMeta}. Absent key = unknown token. */
export type CatMetaMap = Record<string, CatMeta>;

/** A short, human-readable form of a raw TAIL for the unknown-token fallback (e.g. `a406d3…2f81`). */
export function shortTail(tail: string): string {
  const id = normalizeCatId(tail) ?? String(tail ?? '').replace(/^0x/i, '').toLowerCase();
  return id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
}

/** A finite positive integer from any input, else null. */
function positiveInt(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Map a registry `denom` (base units per whole token, a power of ten) to decimal places. */
export function denomToDecimals(denom: unknown): number {
  const d = positiveInt(denom);
  if (d == null) return CAT_DECIMALS;
  const decimals = Math.round(Math.log10(d));
  // Guard against a non-power-of-ten or absurd denom; clamp to a sane range.
  return decimals >= 0 && decimals <= 18 ? decimals : CAT_DECIMALS;
}

/**
 * Parse the dexie swap-token registry JSON → a {@link CatMetaMap}. Tolerant: a non-object, a missing
 * `tokens` array, or any entry with a bad id is skipped; `code`/`name` fall back to the short TAIL.
 */
export function parseCatRegistry(json: unknown): CatMetaMap {
  const tokens = (json as { tokens?: unknown } | null)?.tokens;
  const map: CatMetaMap = {};
  if (!Array.isArray(tokens)) return map;
  for (const t of tokens) {
    const row = t as { id?: unknown; name?: unknown; code?: unknown; denom?: unknown; icon?: unknown };
    const id = normalizeCatId(row.id);
    if (!id) continue;
    const name = typeof row.name === 'string' && row.name.trim() ? row.name.trim() : shortTail(id);
    const ticker = typeof row.code === 'string' && row.code.trim() ? row.code.trim() : 'CAT';
    const iconUrl = typeof row.icon === 'string' && /^https:\/\//i.test(row.icon) ? row.icon : null;
    map[id] = { name, ticker, iconUrl, decimals: denomToDecimals(row.denom) };
  }
  return map;
}

/**
 * Resolve one TAIL against a (possibly-partial / possibly-undefined) registry map. An unknown TAIL —
 * or no registry at all — degrades to a short-form name + generic "CAT" ticker + no icon, so the
 * wallet always lists the holding (§6.1 graceful metadata-unavailable fallback).
 */
export function resolveCatMeta(tail: string, registry?: CatMetaMap | null): CatMeta {
  const id = normalizeCatId(tail) ?? String(tail ?? '').replace(/^0x/i, '').toLowerCase();
  const hit = registry?.[id];
  if (hit) return hit;
  return { name: shortTail(id), ticker: 'CAT', iconUrl: null, decimals: CAT_DECIMALS };
}

/** GET + parse the dexie registry JSON, throwing on a non-2xx response (isolated for a fake fetch). */
export async function fetchCatRegistry(fetchImpl: typeof fetch = fetch): Promise<CatMetaMap> {
  const res = await fetchImpl(DEXIE_TOKENS_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseCatRegistry(await res.json());
}
