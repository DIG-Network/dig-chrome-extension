import { useRef } from 'react';
import type { DragEvent } from 'react';
import { useIntl } from 'react-intl';
import { useAppDispatch } from '@/app/hooks';
import { setOpenApp } from '@/features/ui/uiSlice';
import type { StoreApp } from '@/features/apps/storeCatalog';

/** The personalization actions an editable grid needs (#164) — omitted entirely on a non-editable grid. */
export interface AppLauncherEditActions {
  /** A tile was dropped onto another tile's slot (drag-and-drop reorder). */
  onReorder: (fromIndex: number, toIndex: number) => void;
  /** A tile's keyboard "move up"/"move down" control was activated. */
  onMove: (id: string, direction: 'up' | 'down') => void;
  /** A tile's "hide" control was activated. */
  onHide: (id: string) => void;
}

interface AppLauncherGridProps {
  apps: StoreApp[];
  limit?: number;
  testid?: string;
  /** Enter personalization "edit" mode (#164): drag handles + keyboard move/hide controls per tile,
   * launching is disabled. Omit (default `false`) for a plain launcher grid (e.g. the Home widget). */
  editable?: boolean;
  /** Required when `editable` is true. */
  editActions?: AppLauncherEditActions;
}

/**
 * The mobile-OS dApp icon grid (#65) — squircle icons tinted by each app's `accentColor`, name
 * labels, tap → LAUNCH the dApp into the in-window app-view (§2.4a, like opening a phone app), not a
 * new tab. Shared by the full Apps screen and the Home screen's launcher widget (`limit` trims Home
 * to the first N). The four async states live at the call site.
 *
 * In `editable` mode (Apps tab personalization, #164) tiles become a static icon+label plus a
 * control group (move up / move down / hide) — fully keyboard-operable, no drag required — AND a
 * native HTML5 drag-and-drop source/target for pointer users. Launching is disabled while editable
 * so a stray tap during reordering can't open a dApp.
 */
export function AppLauncherGrid({ apps, limit, testid = 'apps-launcher', editable = false, editActions }: AppLauncherGridProps) {
  const intl = useIntl();
  const dispatch = useAppDispatch();
  const shown = typeof limit === 'number' ? apps.slice(0, limit) : apps;
  const dragIndexRef = useRef<number | null>(null);

  const handleDragStart = (e: DragEvent<HTMLLIElement>, index: number) => {
    dragIndexRef.current = index;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      try {
        e.dataTransfer.setData('text/plain', String(index));
      } catch {
        /* some test/browser environments don't support custom drag data — the ref is authoritative */
      }
    }
  };
  const handleDrop = (e: DragEvent<HTMLLIElement>, index: number) => {
    e.preventDefault();
    const from = dragIndexRef.current;
    dragIndexRef.current = null;
    if (from == null || from === index) return;
    editActions?.onReorder(from, index);
  };

  return (
    <ul className="dig-launcher" data-testid={testid} aria-label={intl.formatMessage({ id: 'apps.title' })}>
      {shown.map((app, index) => (
        <li
          key={app.slug}
          data-testid={editable ? `app-tile-wrap-${app.slug}` : undefined}
          draggable={editable}
          onDragStart={editable ? (e) => handleDragStart(e, index) : undefined}
          onDragOver={editable ? (e) => e.preventDefault() : undefined}
          onDrop={editable ? (e) => handleDrop(e, index) : undefined}
        >
          {editable ? (
            <div className="dig-app-tile dig-app-tile--editable" data-testid={`app-tile-${app.slug}`}>
              <span
                className="dig-app-icon"
                data-testid={`app-icon-${app.slug}`}
                style={app.accentColor ? ({ ['--tile-accent' as string]: app.accentColor }) : undefined}
              >
                <img src={app.icon} alt="" loading="lazy" draggable={false} />
              </span>
              <span className="dig-app-label">{app.name}</span>
              <div
                className="dig-app-tile-controls"
                role="group"
                aria-label={intl.formatMessage({ id: 'apps.tileControls' }, { name: app.name })}
              >
                <button
                  type="button"
                  className="dig-iconbtn dig-iconbtn--sm"
                  data-testid={`app-move-up-${app.slug}`}
                  disabled={index === 0}
                  aria-label={intl.formatMessage({ id: 'apps.moveUp' }, { name: app.name })}
                  onClick={() => editActions?.onMove(app.slug, 'up')}
                >
                  <span aria-hidden="true">↑</span>
                </button>
                <button
                  type="button"
                  className="dig-iconbtn dig-iconbtn--sm"
                  data-testid={`app-move-down-${app.slug}`}
                  disabled={index === shown.length - 1}
                  aria-label={intl.formatMessage({ id: 'apps.moveDown' }, { name: app.name })}
                  onClick={() => editActions?.onMove(app.slug, 'down')}
                >
                  <span aria-hidden="true">↓</span>
                </button>
                <button
                  type="button"
                  className="dig-iconbtn dig-iconbtn--sm"
                  data-testid={`app-hide-${app.slug}`}
                  aria-label={intl.formatMessage({ id: 'apps.hide' }, { name: app.name })}
                  onClick={() => editActions?.onHide(app.slug)}
                >
                  <span aria-hidden="true">✕</span>
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="dig-app-tile"
              data-testid={`app-tile-${app.slug}`}
              aria-label={intl.formatMessage({ id: 'apps.open' }, { name: app.name })}
              onClick={() => dispatch(setOpenApp({ slug: app.slug, name: app.name, link: app.link }))}
            >
              <span
                className="dig-app-icon"
                data-testid={`app-icon-${app.slug}`}
                style={app.accentColor ? ({ ['--tile-accent' as string]: app.accentColor }) : undefined}
              >
                <img src={app.icon} alt="" loading="lazy" draggable={false} />
              </span>
              <span className="dig-app-label">{app.name}</span>
            </button>
          )}
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
