import { useIntl } from 'react-intl';
import { useStorageValue } from '@/lib/useStorageValue';
import { ToggleSwitch } from '@/components/ToggleSwitch';
import { TOOLBAR_ENABLED_KEY, TOOLBAR_ENABLED_DEFAULT } from '@/lib/toolbar';

/**
 * The DIG toolbar enable/disable control, INLINE in the extension window header (#306 item 4 —
 * relocated from the top of the Home tab, #293). A real {@link ToggleSwitch} (not a checkbox, item 3)
 * bound to the SAME `toolbar.enabled` key the injected content script (`dig-toolbar.ts`) + the
 * built-in {@link DigToolbar} read live via `storage.onChanged`, so flipping it here shows/hides BOTH
 * the injected page toolbar and the built-in fullscreen URN bar immediately — one setting, no reload,
 * reachable from any screen.
 */
export function HeaderToolbarToggle() {
  const intl = useIntl();
  const [enabled, setEnabled] = useStorageValue<boolean>(TOOLBAR_ENABLED_KEY, TOOLBAR_ENABLED_DEFAULT);
  const label = intl.formatMessage({ id: 'home.toolbar.label' });

  return (
    <span className="dig-header-toggle" data-testid="header-toolbar-toggle-widget">
      <span className="dig-header-toggle-label" aria-hidden="true">
        {label}
      </span>
      <ToggleSwitch checked={enabled} onChange={setEnabled} label={label} testid="header-toolbar-toggle" />
    </span>
  );
}
