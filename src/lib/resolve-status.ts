/**
 * Resolver node-status view-model — PURE (no DOM / chrome.*) logic for the Resolver tab's
 * "Resolving via" line.
 *
 * The read path resolves a DIG node in the §5.3 order: an explicitly-configured CUSTOM node wins,
 * else `dig.local`, else `localhost`, else the hosted gateway `rpc.dig.net`. The background probe
 * (`getDigNodeStatus`) applies that ladder and reports `{ reachable, base }` for the LOCAL tiers;
 * when no local node is reachable, the read path falls back to the hosted gateway. This module
 * turns that probe result (plus the configured custom host, to name the tier honestly) into a
 * `{ tier, label, endpoint }` the renderer shows — so the resolution verdict is unit-testable and
 * can never silently drift from the §5.3 contract. The popup renderer is thin glue over it.
 */

/** The §5.3 resolution tier that answered (or the hosted-gateway fallback). */
export type ResolveTier = 'custom' | 'dig.local' | 'localhost' | 'rpc.dig.net';

/** The "Resolving via" verdict the Resolver tab renders. */
export interface ResolveVia {
  tier: ResolveTier;
  label: string;
  endpoint: string;
}

/** The relevant subset of a `getDigNodeStatus` probe response. */
export interface DigNodeStatus {
  reachable?: boolean;
  base?: string | null;
}

/** The hosted DIG gateway — the §5.3 FINAL fallback when no local node is reachable. */
export const HOSTED_GATEWAY = 'rpc.dig.net';

/** The §5.3 tiers, most-preferred first. `custom` (explicit override) wins over all others. */
export const RESOLVE_TIERS: readonly ResolveTier[] = Object.freeze([
  'custom',
  'dig.local',
  'localhost',
  'rpc.dig.net',
]);

/** Local host aliases that mean "the standard local node ladder", not a genuine custom override. */
const LOCAL_ALIAS_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'dig.local']);

/** Strip an http(s):// scheme (and any trailing slash) from a base URL, leaving `host[:port]`. */
function hostOf(base: string | null | undefined): string {
  return String(base || '')
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '');
}

/** True when `customHost` names a genuine custom node (not blank, not a local alias). */
export function isCustomHost(customHost: string): boolean {
  const host = hostOf(customHost).split(':')[0].toLowerCase();
  return !!host && !LOCAL_ALIAS_HOSTS.has(host);
}

/**
 * Compute the "Resolving via" verdict from a `getDigNodeStatus` probe result and the configured
 * custom host. The tier is derived primarily from the reachable `base` (the probe already applied
 * the §5.3 ladder, so `base` names whichever tier won); when no node is reachable, the read path
 * uses the hosted gateway.
 */
export function resolveViaStatus(
  { reachable = false, base = null }: DigNodeStatus = {},
  { customHost = '' }: { customHost?: string } = {},
): ResolveVia {
  if (reachable && base) {
    const host = hostOf(base);
    const bare = host.split(':')[0].toLowerCase();
    if (bare === 'dig.local') {
      return { tier: 'dig.local', label: 'Local node (dig.local)', endpoint: base };
    }
    if (bare === 'localhost' || bare === '127.0.0.1' || bare === '::1') {
      return { tier: 'localhost', label: `Local node (${host})`, endpoint: base };
    }
    // A reachable non-alias host is the explicit custom-node override (§5.3 tier 1).
    return { tier: 'custom', label: `Custom node (${host})`, endpoint: base };
  }

  // No local node reachable → the hosted gateway. If a custom node was configured but did not
  // answer, say so honestly (reads still work via the gateway).
  const label = isCustomHost(customHost)
    ? `Hosted network (${HOSTED_GATEWAY}) — custom node unreachable`
    : `Hosted network (${HOSTED_GATEWAY})`;
  return { tier: 'rpc.dig.net', label, endpoint: `https://${HOSTED_GATEWAY}` };
}
