import { useIntl } from 'react-intl';
import { useAppDispatch, useAppSelector } from '@/app/hooks';
import { setLocale, setTheme } from '@/features/ui/uiSlice';
import { LOCALES } from '@/i18n/locales';
import { THEME_MODES, type ThemeMode } from '@/lib/theme';
import { updateWalletSettings } from '@/features/wallet/custody/settings';
import { versionLabel } from '@/lib/version';
import { BugReportLink } from '@/components/BugReportLink';

/** Footer: the subtle app-version display (§6.7) + an inline "Report a bug" entry + the language
 * (§6.6) + theme (#111) selectors — both visible on popup AND fullscreen (`AppFooter` is shared by
 * `CompactLayout`/`ExpandedLayout`). Persists via {@link updateWalletSettings}'s read-modify-write
 * merge so switching one preference never clobbers another (`chainRpcUrl`, `network`, …). */
export function AppFooter() {
  const intl = useIntl();
  const dispatch = useAppDispatch();
  const locale = useAppSelector((s) => s.ui.locale);
  const theme = useAppSelector((s) => s.ui.theme);

  const onLocale = (next: string) => {
    dispatch(setLocale(next));
    void updateWalletSettings({ locale: next });
  };

  const onTheme = (next: ThemeMode) => {
    dispatch(setTheme(next));
    void updateWalletSettings({ theme: next });
  };

  return (
    <footer className="dig-footer">
      <span data-testid="app-version">{versionLabel()}</span>
      <BugReportLink />
      <label className="dig-sr-only" htmlFor="theme-select">
        {intl.formatMessage({ id: 'shell.theme' })}
      </label>
      <select
        id="theme-select"
        data-testid="theme-select"
        className="dig-select"
        style={{ width: 'auto', padding: '4px 8px', fontSize: 11 }}
        value={theme}
        onChange={(e) => onTheme(e.target.value as ThemeMode)}
        aria-label={intl.formatMessage({ id: 'shell.theme' })}
      >
        {THEME_MODES.map((mode) => (
          <option key={mode} value={mode}>
            {intl.formatMessage({ id: `shell.theme.${mode}` })}
          </option>
        ))}
      </select>
      <label className="dig-sr-only" htmlFor="locale-select">
        {intl.formatMessage({ id: 'shell.language' })}
      </label>
      <select
        id="locale-select"
        data-testid="locale-select"
        className="dig-select"
        style={{ width: 'auto', padding: '4px 8px', fontSize: 11 }}
        value={locale}
        onChange={(e) => onLocale(e.target.value)}
        aria-label={intl.formatMessage({ id: 'shell.language' })}
      >
        {LOCALES.map((l) => (
          <option key={l.code} value={l.code}>
            {l.label}
          </option>
        ))}
      </select>
    </footer>
  );
}
