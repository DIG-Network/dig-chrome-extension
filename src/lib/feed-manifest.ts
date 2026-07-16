/**
 * Update-feed manifest client (#583) — fetches the PUBLIC, unauthenticated dig-updater feed manifest
 * (dig-updater SPEC §5.2) and extracts each component's latest advertised version, so the Updates tab
 * can show "is my running dig-node current?" without re-implementing any of dig-updater's own
 * fetch/verify/install machinery (that stays the beacon's job — this reader only wants a display-only
 * "latest version" number, never a trust/install decision).
 *
 * DELIBERATELY does not verify the manifest's Ed25519 signature (dig-updater-trust's job, over the
 * exact signed bytes — see that crate's `manifest.rs`): an unverified "latest version" used only to
 * color an at-a-glance badge carries no security weight, and re-deriving the trust chain here would
 * duplicate the beacon's authority without adding any. A tampered manifest can only mislead this
 * badge, never cause an install — the beacon remains the sole gate for what actually gets installed.
 *
 * Mirrors `priceSources.ts`'s shape: pure parsing + an injectable `fetchImpl` so the network step is
 * unit-testable with a fake fetch.
 */

import type { UpdateChannel } from '@/lib/updater-channel';

/** The primary feed base, matching dig-updater-worker's `PRIMARY_FEED_BASE`. Each channel gets its
 *  own independently-signed manifest under a per-channel path (`/v1/<channel>/manifest.json`, #591). */
export const UPDATE_FEED_BASE = 'https://updates.dig.net/v1';

/** The manifest URL for a given channel's feed (#591 per-channel manifest paths). */
export function feedManifestUrl(channel: UpdateChannel): string {
  return `${UPDATE_FEED_BASE}/${channel}/manifest.json`;
}

/** One component's latest advertised version, as read from the manifest (extra fields ignored). */
export interface FeedComponentVersion {
  name: string;
  version: string;
}

/** Thrown when the feed manifest could not be fetched or held no usable component list. */
export class FeedManifestUnavailableError extends Error {
  constructor(message = 'Update feed unavailable') {
    super(message);
    this.name = 'FeedManifestUnavailableError';
  }
}

/** A non-empty string, else null — tolerates any field being absent or the wrong type. */
function nonEmptyString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Parse the signed manifest envelope (`{ manifest: { components: [...] }, signature }`,
 * dig-updater-trust `Manifest`/`Component`) into just the `{name, version}` pairs this reader needs.
 * Tolerant of any field being absent/malformed — a component missing a name or version is dropped
 * rather than throwing, so a future manifest field this reader doesn't know about never breaks it.
 */
export function parseFeedComponents(json: unknown): FeedComponentVersion[] {
  const envelope = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  const manifest = (envelope.manifest && typeof envelope.manifest === 'object' ? envelope.manifest : {}) as Record<
    string,
    unknown
  >;
  const rawComponents = Array.isArray(manifest.components) ? manifest.components : [];
  const components: FeedComponentVersion[] = [];
  for (const raw of rawComponents) {
    const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const name = nonEmptyString(c.name);
    const version = nonEmptyString(c.version);
    if (name && version) components.push({ name, version });
  }
  return components;
}

/** Find `name`'s latest advertised version in a parsed component list, or `null` if the manifest
 *  doesn't (yet) carry that component. */
export function latestVersionFor(components: FeedComponentVersion[], name: string): string | null {
  return components.find((c) => c.name === name)?.version ?? null;
}

/**
 * Fetch + parse the live feed manifest into its component version list. Throws
 * {@link FeedManifestUnavailableError} on any network/HTTP/JSON failure — the caller (an RTK Query
 * `queryFn`) turns that into an honest "couldn't check for updates" state, never a false "up to date".
 */
export async function fetchFeedComponents(
  channel: UpdateChannel,
  fetchImpl: typeof fetch = fetch,
): Promise<FeedComponentVersion[]> {
  let res: Response;
  try {
    res = await fetchImpl(feedManifestUrl(channel));
  } catch (e) {
    throw new FeedManifestUnavailableError(e instanceof Error ? e.message : 'Update feed unreachable');
  }
  if (!res.ok) throw new FeedManifestUnavailableError(`HTTP ${res.status}`);
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new FeedManifestUnavailableError('Update feed manifest was not valid JSON');
  }
  return parseFeedComponents(json);
}
