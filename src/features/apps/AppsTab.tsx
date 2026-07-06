import { FormattedMessage } from 'react-intl';
import { EXPLORE_URL } from '@/lib/links';
import { ExternalLink } from '@/components/ExternalLink';
import { FourState } from '@/components/FourState';
import { useGetStoreCatalogQuery } from '@/features/apps/appsApi';
import { AppLauncherGrid, AppLauncherSkeleton } from '@/features/apps/AppLauncherGrid';

/**
 * The Apps tab (#65) — the extension's OWN native dApp launcher (no iframe). It fetches
 * explore.dig.net's `/store.json`, caches it for offline/instant paint (stale-while-revalidate, see
 * appsApi), and renders a mobile-OS icon grid: squircle icons tinted by each app's `accentColor`,
 * labels from `name`, tap → open the app's `link` in a new tab. Four states drive the grid (loading
 * skeleton / error+retry / empty / success). A "browse the full store" affordance is always present.
 */
export function AppsTab() {
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
        skeleton={<AppLauncherSkeleton />}
      >
        <AppLauncherGrid apps={apps} />
      </FourState>

      {isFetching && !isLoading && (
        <span className="dig-visually-hidden" role="status" aria-live="polite" data-testid="apps-refreshing">
          <FormattedMessage id="apps.loading" />
        </span>
      )}
    </section>
  );
}
