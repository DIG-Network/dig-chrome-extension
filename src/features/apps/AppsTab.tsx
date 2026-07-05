import { FormattedMessage, useIntl } from 'react-intl';
import { EXPLORE_URL } from '#shared/links.mjs';
import { ExternalLink } from '@/components/ExternalLink';
import { FourState } from '@/components/FourState';
import { useGetStoreCatalogQuery } from '@/features/apps/appsApi';
import type { StoreApp } from '@/features/apps/storeCatalog';

/**
 * The Apps tab (#65) — the extension's OWN native dApp launcher (no iframe). It fetches
 * explore.dig.net's `/store.json`, caches it for offline/instant paint (stale-while-revalidate, see
 * appsApi), and renders a mobile-OS icon grid: squircle icons tinted by each app's `accentColor`,
 * labels from `name`, tap → open the app's `link` in a new tab. Four states drive the grid (loading
 * skeleton / error+retry / empty / success). A "browse the full store" affordance is always present.
 */
export function AppsTab() {
  const intl = useIntl();
  const { data, isLoading, isError, refetch, isFetching } = useGetStoreCatalogQuery();
  const apps = data?.apps ?? [];

  return (
    <section className="dig-appswrap" data-testid="apps-panel" aria-labelledby="apps-title">
      <div className="dig-toggle-row">
        <h2 className="dig-heading" id="apps-title" style={{ margin: 0 }}>
          <FormattedMessage id="apps.title" />
        </h2>
        <ExternalLink href={EXPLORE_URL} testid="apps-open-tab">
          ↗ <FormattedMessage id="apps.openTab" />
        </ExternalLink>
      </div>

      {data?.stale && (
        <p className="dig-muted" role="status" data-testid="apps-offline" style={{ margin: '2px 0 0' }}>
          <FormattedMessage id="apps.offline" />
        </p>
      )}

      <FourState
        isLoading={isLoading}
        isError={isError}
        isEmpty={!isLoading && !isError && apps.length === 0}
        onRetry={() => void refetch()}
        testid="apps"
        loadingId="apps.loading"
        errorId="apps.error"
        emptyId="apps.empty"
        skeleton={<div className="dig-launcher" aria-hidden="true">{Array.from({ length: 6 }, (_, i) => <div key={i} className="dig-app-tile dig-app-tile--skeleton"><div className="dig-app-icon dig-skeleton" /><div className="dig-skeleton" style={{ height: 10, width: '70%', margin: '6px auto 0' }} /></div>)}</div>}
      >
        <ul className="dig-launcher" data-testid="apps-launcher" aria-label={intl.formatMessage({ id: 'apps.title' })}>
          {apps.map((app) => (
            <li key={app.slug}>
              <AppTile app={app} intl={intl} />
            </li>
          ))}
        </ul>
      </FourState>

      {isFetching && !isLoading && (
        <span className="dig-visually-hidden" role="status" aria-live="polite" data-testid="apps-refreshing">
          <FormattedMessage id="apps.loading" />
        </span>
      )}
    </section>
  );
}

/** One launcher icon: squircle icon tinted by the app's accent, its name, tap → open the app. */
function AppTile({ app, intl }: { app: StoreApp; intl: ReturnType<typeof useIntl> }) {
  const tint = app.accentColor;
  return (
    <ExternalLink
      href={app.link}
      className="dig-app-tile"
      testid={`app-tile-${app.slug}`}
      closePopup
    >
      <span
        className="dig-app-icon"
        data-testid={`app-icon-${app.slug}`}
        style={tint ? ({ ['--tile-accent' as string]: tint }) : undefined}
      >
        <img src={app.icon} alt="" loading="lazy" draggable={false} />
      </span>
      <span className="dig-app-label">{app.name}</span>
      <span className="dig-visually-hidden">{intl.formatMessage({ id: 'apps.open' }, { name: app.name })}</span>
    </ExternalLink>
  );
}
