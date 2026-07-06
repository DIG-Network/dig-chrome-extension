import { useIntl, FormattedMessage } from 'react-intl';
import { FourState } from '@/components/FourState';
import type { OriginPermission } from '@/lib/wallet-broker';
import {
  useGetConnectedSitesQuery,
  useRevokeConnectedSiteMutation,
  useRevokeAllConnectedSitesMutation,
} from '@/features/wallet/custody/connectedSitesApi';

/**
 * Connected sites (#67 P0-4) — the Settings/Advanced screen listing every origin the wallet is
 * connected to, with per-site revoke + revoke-all. Consent is inspectable and revocable, not a
 * permanent boolean: each row shows the site, the addresses it can see, when access was granted, and
 * when it was last used; Revoke clears that origin's consent so it must re-request to reconnect.
 * Reads/writes go through the SW over RTK Query (tag-invalidated), so a revoke updates the list live.
 */
export function ConnectedSites() {
  const { data, isLoading, isError, refetch } = useGetConnectedSitesQuery();
  const [revokeAll, allState] = useRevokeAllConnectedSitesMutation();
  const sites = data?.sites ?? [];

  return (
    <section className="dig-card" data-testid="connected-sites" aria-labelledby="connected-sites-title">
      <h2 className="dig-heading" id="connected-sites-title" style={{ marginTop: 0 }}>
        <FormattedMessage id="sites.title" />
      </h2>
      <p className="dig-muted" style={{ marginTop: 0 }}>
        <FormattedMessage id="sites.subtitle" />
      </p>
      <FourState
        isLoading={isLoading}
        isError={isError}
        isEmpty={!isLoading && !isError && sites.length === 0}
        onRetry={refetch}
        testid="connected-sites"
        loadingId="sites.loading"
        errorId="sites.error"
        emptyId="sites.empty"
      >
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }} data-testid="connected-sites-list">
          {sites.map((s) => (
            <SiteRow key={s.origin} site={s} />
          ))}
        </ul>
        {sites.length > 0 && (
          <button
            type="button"
            className="dig-btn dig-btn--ghost dig-btn--block"
            data-testid="connected-sites-revoke-all"
            style={{ marginTop: 12 }}
            disabled={allState.isLoading}
            onClick={() => void revokeAll()}
          >
            <FormattedMessage id="sites.revokeAll" />
          </button>
        )}
      </FourState>
    </section>
  );
}

/** Extract a display host from an origin (falls back to the raw origin). */
function hostOf(origin: string): string {
  try {
    return new URL(origin).host || origin;
  } catch {
    return origin;
  }
}

/** One connected site: host + granted/last-used + addresses, with a Revoke button. */
function SiteRow({ site }: { site: OriginPermission }) {
  const intl = useIntl();
  const [revoke, state] = useRevokeConnectedSiteMutation();
  const granted = site.grantedAt ? intl.formatDate(site.grantedAt, { dateStyle: 'medium' }) : '—';
  const lastUsed = site.lastUsed ? intl.formatDate(site.lastUsed, { dateStyle: 'medium' }) : '—';

  return (
    <li
      className="dig-site-row"
      data-testid={`connected-site-${hostOf(site.origin)}`}
      style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start', padding: '10px 0', borderTop: '1px solid var(--dig-border)' }}
    >
      <div style={{ minWidth: 0 }}>
        <p className="dig-mono" style={{ margin: 0, fontWeight: 600, wordBreak: 'break-all' }}>{hostOf(site.origin)}</p>
        <p className="dig-muted" style={{ margin: '2px 0 0', fontSize: 12 }}>
          <FormattedMessage id="sites.granted" values={{ date: granted }} />
          {' · '}
          <FormattedMessage id="sites.lastUsed" values={{ date: lastUsed }} />
        </p>
        {site.addresses.length > 0 && (
          <p className="dig-muted dig-mono" style={{ margin: '2px 0 0', fontSize: 12, wordBreak: 'break-all' }}>
            <FormattedMessage id="sites.addresses" values={{ count: site.addresses.length }} />
          </p>
        )}
      </div>
      <button
        type="button"
        className="dig-btn dig-btn--ghost"
        data-testid={`connected-site-revoke-${hostOf(site.origin)}`}
        aria-label={intl.formatMessage({ id: 'sites.revoke.aria' }, { host: hostOf(site.origin) })}
        disabled={state.isLoading}
        onClick={() => void revoke({ origin: site.origin })}
      >
        <FormattedMessage id="sites.revoke" />
      </button>
    </li>
  );
}
