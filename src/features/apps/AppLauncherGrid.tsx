import { useIntl } from 'react-intl';
import { ExternalLink } from '@/components/ExternalLink';
import type { StoreApp } from '@/features/apps/storeCatalog';

/**
 * The mobile-OS dApp icon grid (#65) — squircle icons tinted by each app's `accentColor`, name
 * labels, tap → open the app's `link` in a new tab. Shared by the full Apps screen and the Home
 * screen's launcher widget (`limit` trims Home to the first N). Pure/presentational: it takes the
 * already-fetched app list; the four async states live at the call site.
 */
export function AppLauncherGrid({ apps, limit, testid = 'apps-launcher' }: { apps: StoreApp[]; limit?: number; testid?: string }) {
  const intl = useIntl();
  const shown = typeof limit === 'number' ? apps.slice(0, limit) : apps;
  return (
    <ul className="dig-launcher" data-testid={testid} aria-label={intl.formatMessage({ id: 'apps.title' })}>
      {shown.map((app) => (
        <li key={app.slug}>
          <ExternalLink href={app.link} className="dig-app-tile" testid={`app-tile-${app.slug}`} closePopup>
            <span
              className="dig-app-icon"
              data-testid={`app-icon-${app.slug}`}
              style={app.accentColor ? ({ ['--tile-accent' as string]: app.accentColor }) : undefined}
            >
              <img src={app.icon} alt="" loading="lazy" draggable={false} />
            </span>
            <span className="dig-app-label">{app.name}</span>
            <span className="dig-visually-hidden">{intl.formatMessage({ id: 'apps.open' }, { name: app.name })}</span>
          </ExternalLink>
        </li>
      ))}
    </ul>
  );
}

/** A skeleton placeholder grid (N shimmering tiles) for the loading state. */
export function AppLauncherSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="dig-launcher" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="dig-app-tile dig-app-tile--skeleton">
          <div className="dig-app-icon dig-skeleton" />
          <div className="dig-skeleton" style={{ height: 10, width: '70%', margin: '6px auto 0' }} />
        </div>
      ))}
    </div>
  );
}
