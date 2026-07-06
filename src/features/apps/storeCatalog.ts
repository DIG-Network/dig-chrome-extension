/**
 * The DIG dApp store catalog (#65) — the normative `/store.json` contract published by
 * explore.dig.net (v0.5.0, explore SPEC §5.1; recorded in the superproject SYSTEM.md). The extension
 * fetches it and renders its OWN native launcher (no iframe), so this module owns the wire shape +
 * the pure normalization (validate + featured-first order) that the launcher + its tests build on.
 *
 * Wire shape (`https://explore.dig.net/store.json`, CORS `*`):
 *   { generatedAt, version, apps: [{ slug, name, icon, link, category, featured, accentColor? }] }
 * `icon` and `link` are ABSOLUTE URLs. Featured entries come first.
 */

import { EXPLORE_URL } from '@/lib/links';

/** The live store manifest URL (absolute icons/links; CORS `*`). */
export const STORE_JSON_URL = `${EXPLORE_URL}/store.json`;

/** `chrome.storage.local` key: the last good catalog (stale-while-revalidate; offline paint). */
export const STORE_CACHE_KEY = 'appsCache.store';

/** One dApp in the launcher (a normalized, render-ready entry). */
export interface StoreApp {
  slug: string;
  name: string;
  /** Absolute icon URL (square PNG). */
  icon: string;
  /** Absolute launch URL. */
  link: string;
  category: string;
  featured: boolean;
  /** Optional brand accent (hex) used as the tile tint. */
  accentColor?: string;
}

/** The launcher's data: the app list + whether it came from the offline cache. */
export interface StoreCatalog {
  apps: StoreApp[];
  /** True when served from the cache because the network fetch failed (offline). */
  stale: boolean;
}

const isHttpsUrl = (v: unknown): v is string => typeof v === 'string' && /^https:\/\//i.test(v);
const isHex = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-f]{3,8}$/i.test(v);

/**
 * Normalize raw `/store.json` into a render-ready, validated, featured-first app list. Drops any
 * entry missing a slug/name or a valid absolute https icon+link (defensive against a malformed or
 * partially-published manifest); the sort is stable so explore's within-group order is preserved.
 */
export function normalizeCatalog(raw: unknown): StoreApp[] {
  const rawApps = (raw as { apps?: unknown } | null)?.apps;
  if (!Array.isArray(rawApps)) return [];
  const apps: StoreApp[] = [];
  for (const entry of rawApps) {
    const e = entry as Record<string, unknown>;
    if (typeof e?.slug !== 'string' || !e.slug) continue;
    if (typeof e?.name !== 'string' || !e.name) continue;
    if (!isHttpsUrl(e.icon) || !isHttpsUrl(e.link)) continue;
    apps.push({
      slug: e.slug,
      name: e.name,
      icon: e.icon,
      link: e.link,
      category: typeof e.category === 'string' ? e.category : 'other',
      featured: e.featured === true,
      ...(isHex(e.accentColor) ? { accentColor: e.accentColor } : {}),
    });
  }
  // Featured first; stable within each group (index-preserving comparator).
  return apps
    .map((app, i) => ({ app, i }))
    .sort((a, b) => Number(b.app.featured) - Number(a.app.featured) || a.i - b.i)
    .map((x) => x.app);
}
