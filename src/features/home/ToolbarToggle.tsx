import { FormattedMessage, useIntl } from 'react-intl';
import { useStorageValue } from '@/lib/useStorageValue';
import { StatusPill } from '@/components/StatusPill';
import { TOOLBAR_ENABLED_KEY, TOOLBAR_ENABLED_DEFAULT } from '@/lib/toolbar';

/**
 * #293 — the injected page toolbar's (#292) enable/disable switch, moved to the TOP of the Home
 * screen for quick activate/deactivate (it used to live on the options page only). Persists the
 * SAME `toolbar.enabled` key the content script (`dig-toolbar.ts`) already reads live via
 * `storage.onChanged`, so toggling here shows/hides the toolbar on every open tab immediately — no
 * reload, no second source of truth.
 */
export function ToolbarToggle() {
  const intl = useIntl();
  const [enabled, setEnabled] = useStorageValue<boolean>(TOOLBAR_ENABLED_KEY, TOOLBAR_ENABLED_DEFAULT);
  const label = intl.formatMessage({ id: 'home.toolbar.label' });

  return (
    <div className="dig-widget dig-toggle-row" data-testid="home-toolbar-toggle-widget">
      <label htmlFor="home-toolbar-toggle">{label}</label>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
        <StatusPill tone={enabled ? 'good' : 'neutral'} testid="home-toolbar-toggle-status">
          <FormattedMessage id={enabled ? 'resolver.status.active' : 'resolver.status.inactive'} />
        </StatusPill>
        <input
          id="home-toolbar-toggle"
          type="checkbox"
          data-testid="home-toolbar-toggle"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          aria-label={label}
        />
      </span>
    </div>
  );
}
