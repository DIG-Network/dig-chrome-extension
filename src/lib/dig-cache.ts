/**
 * DIG Control Panel — the CACHE/LRU management brain (#279/#281). Pure, DOM-free, chrome-free
 * logic the `ControlTab` cache section renders through: humanize byte sizes, compute the used/cap
 * bar, parse the "reserved cap" input (floored at the node's 64 MiB minimum), and shape the cached
 * capsule list into an LRU-ordered view (rank 0 = next to be evicted).
 *
 * The node's OPEN `cache.*` surface (no control token) is the source of truth — this module only
 * SHAPES its responses for display, keeping `ControlTab.tsx` thin. Wire contract (dig-node SPEC
 * §7.10): `cache.listCached` entries carry `{capsule,store_id,root,size_bytes,last_used_unix_ms,
 * lru_rank}`; `cache.getConfig`→`{cap_bytes,used_bytes}`; `cache.stats`→`{cap_bytes,used_bytes,
 * entry_count,total_bytes,evicted_count,evicted_bytes,content_cache:{hits,misses}}`.
 */

/** The node's hard floor for the reserved cache cap (mirrors `cache.setCapBytes`, dig-node SPEC §7.10). */
export const MIN_CACHE_CAP_BYTES = 64 * 1024 * 1024;

/** Humanize a byte count to a short, locale-neutral string (`0 B`, `512 KiB`, `1.5 GiB`). */
export function formatBytes(bytes: number | null | undefined): string {
  const n = typeof bytes === 'number' && Number.isFinite(bytes) && bytes >= 0 ? bytes : 0;
  if (n < 1024) return `${n} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // One decimal below 10 (1.5 GiB), whole numbers above (512 MiB) — compact but precise.
  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}

/** The used-fraction of the cap as a clamped 0..100 integer percentage (0 when cap is 0). */
export function cacheUsagePercent(usedBytes: number, capBytes: number): number {
  if (!Number.isFinite(capBytes) || capBytes <= 0) return 0;
  const pct = Math.round((Math.max(0, usedBytes) / capBytes) * 100);
  return Math.min(100, Math.max(0, pct));
}

/** A byte-input unit the reserved-cap control offers. */
export type CapUnit = 'MiB' | 'GiB';

/**
 * Parse a reserved-cap input (a number + unit) into a byte count, floored at
 * {@link MIN_CACHE_CAP_BYTES}. Returns `null` for a non-positive / non-numeric input so the UI can
 * show an inline validation error rather than silently sending garbage.
 */
export function parseCapToBytes(value: string | number, unit: CapUnit): number | null {
  const num = typeof value === 'number' ? value : parseFloat(String(value).trim());
  if (!Number.isFinite(num) || num <= 0) return null;
  const multiplier = unit === 'GiB' ? 1024 * 1024 * 1024 : 1024 * 1024;
  const bytes = Math.floor(num * multiplier);
  return Math.max(MIN_CACHE_CAP_BYTES, bytes);
}

/** One cached capsule as the node reports it (`cache.listCached`). */
export interface CachedEntry {
  capsule?: string;
  store_id: string;
  root: string;
  size_bytes: number;
  last_used_unix_ms: number;
  lru_rank: number;
}

/** A cached entry shaped for display (LRU-ordered, pre-humanized). */
export interface CachedEntryView {
  capsule: string;
  storeId: string;
  root: string;
  sizeBytes: number;
  sizeLabel: string;
  lastUsedUnixMs: number;
  lruRank: number;
  /** A short, stable key (`storeId:root`) for React lists + removeCached params. */
  key: string;
}

/**
 * Shape the raw `cache.listCached` array into an LRU-ordered, humanized view (rank 0 — the next
 * capsule the cap would evict — FIRST). Tolerates missing fields defensively.
 */
export function cachedEntriesView(cached: CachedEntry[] | null | undefined): CachedEntryView[] {
  const list = Array.isArray(cached) ? cached : [];
  return list
    .map((c) => ({
      capsule: c.capsule || `${c.store_id}:${c.root}`,
      storeId: c.store_id,
      root: c.root,
      sizeBytes: c.size_bytes ?? 0,
      sizeLabel: formatBytes(c.size_bytes),
      lastUsedUnixMs: c.last_used_unix_ms ?? 0,
      lruRank: c.lru_rank ?? 0,
      key: `${c.store_id}:${c.root}`,
    }))
    .sort((a, b) => a.lruRank - b.lruRank);
}

/** The node's `cache.stats` response (only the fields the view reads). */
export interface CacheStats {
  cap_bytes?: number;
  used_bytes?: number;
  entry_count?: number;
  total_bytes?: number;
  evicted_count?: number;
  evicted_bytes?: number;
  content_cache?: { hits?: number; misses?: number } | null;
}

/** A humanized `cache.stats` summary for the telemetry line. */
export interface CacheStatsView {
  entryCount: number;
  totalLabel: string;
  usedLabel: string;
  capLabel: string;
  usagePercent: number;
  evictedCount: number;
  evictedLabel: string;
  hits: number;
  misses: number;
  /** Whole-percent hit-rate over hits+misses, or `null` when there were no lookups yet. */
  hitRatePercent: number | null;
}

/** Shape `cache.stats` for display (humanized sizes + derived usage/hit-rate). */
export function cacheStatsView(stats: CacheStats | null | undefined): CacheStatsView {
  const s = stats || {};
  const hits = s.content_cache?.hits ?? 0;
  const misses = s.content_cache?.misses ?? 0;
  const lookups = hits + misses;
  return {
    entryCount: s.entry_count ?? 0,
    totalLabel: formatBytes(s.total_bytes),
    usedLabel: formatBytes(s.used_bytes),
    capLabel: formatBytes(s.cap_bytes),
    usagePercent: cacheUsagePercent(s.used_bytes ?? 0, s.cap_bytes ?? 0),
    evictedCount: s.evicted_count ?? 0,
    evictedLabel: formatBytes(s.evicted_bytes),
    hits,
    misses,
    hitRatePercent: lookups > 0 ? Math.round((hits / lookups) * 100) : null,
  };
}
