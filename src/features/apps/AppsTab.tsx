import { useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { EXPLORE_URL } from '@/lib/links';
import { ExternalLink } from '@/components/ExternalLink';
import { FourState } from '@/components/FourState';
import { useGetStoreCatalogQuery } from '@/features/apps/appsApi';
import { AppLauncherGrid, AppLauncherSkeleton } from '@/features/apps/AppLauncherGrid';
import { usePersonalizedApps } from '@/features/apps/usePersonalizedApps';
import type { StoreApp } from '@/features/apps/storeCatalog';

/**
 * The Apps tab (#65) — the extension's OWN native dApp launcher (no iframe). It fetches
 * explore.dig.net's `/store.json`, caches it for offline/instant paint (stale-while-revalidate, see
 * appsApi), and renders a mobile-OS icon grid: squircle icons tinted by each app's `accentColor`,
 * labels from `name`, tap → open the app's `link` in a new tab. Four states drive the grid (loading
 * skeleton / error+retry / empty / success). A "browse the full store" affordance is always present.
 *
 * On top of the server-owned catalog, `usePersonalizedApps` (#164) layers a LOCAL, per-device view:
 * a custom drag/keyboard-reorderable order and a hide/show-hidden set, persisted to
 * `chrome.storage.local` and reconciled against catalog churn (a removed app drops silently, a new
 * one appears visible at the end). "Edit" toggles per-tile reorder + hide controls; personalization
 * never touches the FourState branches — it is a transform applied only to the success-state list.
 */
export function AppsTab() {
  const intl = useIntl();
  const { data, isLoading, isError, refetch, isFetching } = useGetStoreCatalogQuery();
  const apps = data?.apps ?? [];
  const { visible, hiddenApps, reorder, moveApp, hideApp, showApp } = usePersonalizedApps(apps);
  const [editing, setEditing] = useState(false);
  const [hiddenExpanded, setHiddenExpanded] = useState(false);
  const [announcement, setAnnouncement] = useState('');

  const announceMoved = (id: string, toIndex: number): void => {
    const name = visible.find((a) => a.slug === id)?.name ?? id;
    setAnnouncement(intl.formatMessage({ id: 'apps.reordered' }, { name, position: toIndex + 1, total: visible.length }));
  };

  const handleReorder = (from: number, to: number): void => {
    const id = visible[from]?.slug;
    reorder(from, to);
    if (id) announceMoved(id, to);
  };

  const handleMove = (id: string, direction: 'up' | 'down'): void => {
    const from = visible.findIndex((a) => a.slug === id);
    const to = direction === 'up' ? from - 1 : from + 1;
    if (from < 0 || to < 0 || to >= visible.length) return;
    moveApp(id, direction);
    announceMoved(id, to);
  };

  const handleHide = (id: string): void => {
    const name = visible.find((a) => a.slug === id)?.name ?? id;
    hideApp(id);
    setAnnouncement(intl.formatMessage({ id: 'apps.hiddenAnnounce' }, { name }));
  };

  const handleShow = (id: string): void => {
    const name = hiddenApps.find((a) => a.slug === id)?.name ?? id;
    showApp(id);
    setAnnouncement(intl.formatMessage({ id: 'apps.shownAnnounce' }, { name }));
  };

  return (
    <section className="dig-appswrap" data-testid="apps-panel" aria-labelledby="apps-title">
      <div className="dig-toggle-row">
        <h2 className="dig-heading" id="apps-title" style={{ margin: 0 }}>
          <FormattedMessage id="apps.title" />
        </h2>
        <div className="dig-apps-actions">
          <button
            type="button"
            className={`dig-iconbtn${editing ? ' dig-iconbtn--active' : ''}`}
            data-testid="apps-edit-toggle"
            aria-pressed={editing}
            aria-label={intl.formatMessage({ id: editing ? 'apps.editDone' : 'apps.edit' })}
            title={intl.formatMessage({ id: editing ? 'apps.editDone' : 'apps.edit' })}
            onClick={() => setEditing((e) => !e)}
          >
            {/* Icon-only (not a text button, #163) so the toggle-row never risks popup h-scroll,
                regardless of how long "Edit"/"Done" translates in any of the 14 locales. */}
            <span aria-hidden="true">{editing ? '✓' : '✎'}</span>
          </button>
          <ExternalLink href={EXPLORE_URL} testid="apps-open-tab">
            ↗ <FormattedMessage id="apps.openTab" />
          </ExternalLink>
        </div>
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
        <AppLauncherGrid
          apps={visible}
          editable={editing}
          editActions={{ onReorder: handleReorder, onMove: handleMove, onHide: handleHide }}
        />
        {hiddenApps.length > 0 && (
          <HiddenAppsPanel apps={hiddenApps} expanded={hiddenExpanded} onToggle={() => setHiddenExpanded((v) => !v)} onShow={handleShow} />
        )}
      </FourState>

      <span className="dig-visually-hidden" role="status" aria-live="polite" data-testid="apps-announce">
        {announcement}
      </span>

      {isFetching && !isLoading && (
        <span className="dig-visually-hidden" role="status" aria-live="polite" data-testid="apps-refreshing">
          <FormattedMessage id="apps.loading" />
        </span>
      )}
    </section>
  );
}

/** The "Show hidden (N)" disclosure — expands to a list of hidden apps, each with an Unhide action. */
function HiddenAppsPanel({
  apps,
  expanded,
  onToggle,
  onShow,
}: {
  apps: StoreApp[];
  expanded: boolean;
  onToggle: () => void;
  onShow: (id: string) => void;
}) {
  const intl = useIntl();
  return (
    <div className="dig-hidden-apps" data-testid="apps-hidden-panel">
      <button type="button" className="dig-link" data-testid="apps-hidden-toggle" aria-expanded={expanded} onClick={onToggle}>
        <FormattedMessage id="apps.hidden.toggle" values={{ count: apps.length }} />
      </button>
      {expanded && (
        <ul className="dig-hidden-apps-list" data-testid="apps-hidden-list">
          {apps.map((app) => (
            <li key={app.slug} className="dig-row" data-testid={`hidden-app-${app.slug}`}>
              <span className="dig-row-main">{app.name}</span>
              <button
                type="button"
                className="dig-btn dig-btn--sm"
                data-testid={`app-unhide-${app.slug}`}
                aria-label={intl.formatMessage({ id: 'apps.unhide' }, { name: app.name })}
                onClick={() => onShow(app.slug)}
              >
                <FormattedMessage id="apps.show" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
