import type { PillTone } from '@/components/StatusPill';

/**
 * The running dig-node's own version, compared against the public update-feed manifest, so the
 * Updates tab can show an honest "up to date" / "update available" verdict for the NODE itself —
 * distinct from the dig-updater/beacon version already shown by `updater-status.ts` (#583).
 *
 * This module is pure and DOM-free (no chrome.* API, no react-intl) so the version-compare + badge-state
 * decision is unit-testable in isolation; `NodeVersionSection.tsx` is the sole consumer, mapping
 * {@link NodeVersionBadgeKind} to react-intl ids and {@link StatusPill} tones.
 */

/** The four things the badge can honestly say — never a false "up to date" (§6.4 four-state). */
export type NodeVersionBadgeKind = 'nodeOffline' | 'feedUnreachable' | 'upToDate' | 'updateAvailable';

/** The badge's rendered verdict. `latestVersion` is populated only for `updateAvailable`, where the
 *  copy names the version to update to. */
export interface NodeVersionBadge {
  kind: NodeVersionBadgeKind;
  latestVersion?: string;
}

/** Check if a version string is well-formed enough to compare (at least one digit in the
 *  release part, after stripping leading `v`). A malformed feed entry (e.g. "invalid", empty)
 *  is treated as unreachable, preventing a false "up to date" verdict from a garbage feed. */
function hasValidVersionFormat(raw: string): boolean {
  const trimmed = raw.trim().replace(/^v/i, '');
  if (!trimmed) return false; // empty string
  const core = trimmed.split('-')[0]; // prerelease is after the first `-`
  return /\d/.test(core); // at least one digit in the release part
}

/**
 * Decide the badge from the two independent, already-settled reads: the node's own live status
 * (`getNodeLiveStatus`, #239 — unrelated to beacon health) and the feed manifest's advertised
 * `dig-node` version (`feed-manifest.ts`). Every input is the CALLER's job to have already resolved
 * (loading is a component-level concern, not this function's) — passing a `null` for either version
 * is exactly how "don't know yet" is expressed, and this function never guesses "up to date" from a
 * `null` or a malformed feed entry.
 *
 * @param nodeOnline the node's live-status connection is `'connected'` (see `dig-node-ws.ts`).
 * @param runningVersion the node's own reported version, or `null` if not connected / not yet known.
 * @param latestVersion the feed's `dig-node` version, or `null` if the feed is unreachable or the
 *   feed's manifest doesn't (yet) carry a `dig-node` entry. If present but malformed, treated as unreachable.
 */
export function nodeVersionBadge({
  nodeOnline,
  runningVersion,
  latestVersion,
}: {
  nodeOnline: boolean;
  runningVersion: string | null;
  latestVersion: string | null;
}): NodeVersionBadge {
  if (!nodeOnline || !runningVersion) return { kind: 'nodeOffline' };
  if (!latestVersion || !hasValidVersionFormat(latestVersion)) return { kind: 'feedUnreachable' };
  return isOlder(runningVersion, latestVersion) ? { kind: 'updateAvailable', latestVersion } : { kind: 'upToDate' };
}

/** The message-catalog id for a badge kind (react-intl consumes this; never raw prose here). */
export function nodeVersionBadgeLabelId(kind: NodeVersionBadgeKind): string {
  switch (kind) {
    case 'nodeOffline':
      return 'updates.nodeVersion.badge.nodeOffline';
    case 'feedUnreachable':
      return 'updates.nodeVersion.badge.feedUnreachable';
    case 'upToDate':
      return 'updates.nodeVersion.badge.upToDate';
    case 'updateAvailable':
      return 'updates.nodeVersion.badge.updateAvailable';
  }
}

/** The {@link StatusPill} tone for a badge kind — `updateAvailable` is the only one worth a second
 *  glance; the two "don't know" kinds stay neutral rather than alarming (they are not failures the
 *  user caused), matching `updater-status.ts`'s tone philosophy. */
export function nodeVersionBadgeTone(kind: NodeVersionBadgeKind): PillTone {
  switch (kind) {
    case 'upToDate':
      return 'good';
    case 'updateAvailable':
      return 'warn';
    case 'nodeOffline':
    case 'feedUnreachable':
      return 'neutral';
  }
}

/** One semver release triple plus its optional prerelease identifier (build metadata is dropped —
 *  semver precedence never considers it). */
interface ParsedVersion {
  release: readonly [number, number, number];
  prerelease: string | null;
}

/** Parse a semver-ish string tolerantly: a leading `v` is stripped, a missing minor/patch defaults
 *  to `0`, and anything after a `+` (build metadata) is discarded. Never throws — a component this
 *  reader doesn't understand degrades to `0`, so a malformed feed entry can't crash the badge. */
function parseVersion(raw: string): ParsedVersion {
  const [core, ...prereleaseParts] = raw.trim().replace(/^v/i, '').split('-');
  const [major = 0, minor = 0, patch = 0] = core.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const prerelease = prereleaseParts.length > 0 ? prereleaseParts.join('-').split('+')[0] : null;
  return { release: [major, minor, patch], prerelease };
}

/**
 * True when `a` is strictly a lower semver precedence than `b`. Compares the release triple
 * numerically first; when the triple is equal, a prerelease sorts BEFORE its plain release
 * (`1.0.0-rc.1 < 1.0.0`, per the SemVer spec) and two prereleases compare lexicographically (this
 * codebase's alpha channel names prereleases predictably enough that a full dot-segment-by-segment
 * comparison isn't warranted).
 */
export function isOlder(a: string, b: string): boolean {
  return compareVersions(a, b) < 0;
}

/** -1 / 0 / 1 semver comparison of two version strings (tolerant of a leading `v`, a missing
 *  minor/patch, and build metadata — see {@link parseVersion}). */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (pa.release[i] !== pb.release[i]) return pa.release[i] < pb.release[i] ? -1 : 1;
  }
  if (pa.prerelease === pb.prerelease) return 0;
  if (pa.prerelease === null) return 1; // a plain release outranks any prerelease of the same triple
  if (pb.prerelease === null) return -1;
  return pa.prerelease < pb.prerelease ? -1 : 1;
}
