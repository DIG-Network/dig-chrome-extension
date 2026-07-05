import { useIntl } from 'react-intl';
import { useAppDispatch, useAppSelector } from '@/app/hooks';
import { setLocale } from '@/features/ui/uiSlice';
import { LOCALES } from '@/i18n/locales';
import { storageSet } from '@/lib/messaging';
import { versionLabel } from '@/lib/version';
import { BugReportLink } from '@/components/BugReportLink';

const SETTINGS_KEY = 'wallet.settings';

/** Footer: the subtle app-version display (§6.7) + an inline "Report a bug" entry + the language selector (§6.6). */
export function AppFooter() {
  const intl = useIntl();
  const dispatch = useAppDispatch();
  const locale = useAppSelector((s) => s.ui.locale);
  const advanced = useAppSelector((s) => s.ui.advanced);

  const onLocale = (next: string) => {
    dispatch(setLocale(next));
    void storageSet({ [SETTINGS_KEY]: { locale: next, advanced } });
  };

  return (
    <footer className="dig-footer">
      <span data-testid="app-version">{versionLabel()}</span>
      <BugReportLink />
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
