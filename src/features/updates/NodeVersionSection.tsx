import { FormattedMessage } from 'react-intl';
import { StatusPill } from '@/components/StatusPill';
import { useGetNodeLiveStatusQuery } from '@/features/control/nodeApi';
import { useGetFeedManifestQuery } from '@/features/updates/feedManifestApi';
import { latestVersionFor } from '@/lib/feed-manifest';
import { nodeVersionBadge, nodeVersionBadgeLabelId, nodeVersionBadgeTone } from '@/lib/node-version';

/** The feed's component name for the dig-node build (matches dig-updater-trust's `Component.name`). */
const DIG_NODE_COMPONENT = 'dig-node';

/**
 * The running **dig-node** version + an out-of-date badge (#583) — distinct from the dig-updater/
 * beacon version `UpdaterPanel` shows via `updater-status.ts`. Sources the running version from the
 * SAME live `getNodeLiveStatus` WS status (#239) the Control tab's connection pill already reads —
 * it is the node's OWN reported build, independent of whether the beacon is installed or healthy —
 * and compares it against the public update-feed manifest's advertised `dig-node` version.
 *
 * Renders unconditionally at the top of the Updates tab (no pairing needed — `getNodeLiveStatus` is
 * the same unauthenticated liveness signal the popup header already shows), so a user sees this even
 * when the beacon panel below is gated behind pairing or `install`-mode.
 */
export function NodeVersionSection() {
  const live = useGetNodeLiveStatusQuery();
  const feed = useGetFeedManifestQuery();

  // Both reads settle independently and quickly (a cached SW snapshot + a long-TTL public fetch);
  // showing one brief skeleton for the pair is simpler than a two-speed loading UI and avoids ever
  // computing the badge from a still-in-flight read.
  if (live.isLoading || feed.isLoading) {
    return (
      <section className="dig-card" data-testid="updates-node-version-loading">
        <div className="dig-skeleton" />
      </section>
    );
  }

  const nodeOnline = live.data?.state === 'connected';
  const runningVersion = live.data?.version ?? null;
  const latestVersion = feed.data ? latestVersionFor(feed.data, DIG_NODE_COMPONENT) : null;
  const badge = nodeVersionBadge({ nodeOnline, runningVersion, latestVersion });

  return (
    <section className="dig-card" data-testid="updates-node-version" aria-labelledby="updates-node-version-title">
      <h3 className="dig-subheading" id="updates-node-version-title" style={{ margin: '0 0 8px' }}>
        <FormattedMessage id="updates.nodeVersion.title" />
      </h3>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }} role="status" aria-live="polite">
        {runningVersion && (
          <span className="dig-muted" data-testid="updates-node-version-value">
            <FormattedMessage id="updates.nodeVersion.value" values={{ version: runningVersion }} />
          </span>
        )}
        <StatusPill tone={nodeVersionBadgeTone(badge.kind)} testid="updates-node-version-badge">
          {badge.kind === 'updateAvailable' ? (
            <FormattedMessage id={nodeVersionBadgeLabelId(badge.kind)} values={{ version: badge.latestVersion }} />
          ) : (
            <FormattedMessage id={nodeVersionBadgeLabelId(badge.kind)} />
          )}
        </StatusPill>
      </div>
    </section>
  );
}
