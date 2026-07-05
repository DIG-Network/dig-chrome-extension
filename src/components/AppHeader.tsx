import { useIntl } from 'react-intl';
import { useAppSelector } from '@/app/hooks';
import { routeToHash } from '@/app/tabs';
import { popOutToFullpage } from '@/lib/popout';
import { hasRuntime } from '@/lib/messaging';
import type { Surface } from '@/app/layout';

/** Top header: brand lockup + ⤢ pop-out (popup only) + DIG settings. */
export function AppHeader({ surface }: { surface: Surface }) {
  const intl = useIntl();
  const tab = useAppSelector((s) => s.ui.tab);
  const walletView = useAppSelector((s) => s.ui.walletView);
  const networkView = useAppSelector((s) => s.ui.networkView);

  const openSettings = () => {
    if (!hasRuntime()) return;
    if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
    else if (chrome.tabs) void chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
  };

  return (
    <header className="dig-header">
      <div className="dig-brand">
        <span className="dig-brand-dot" aria-hidden="true" />
        <h1>{intl.formatMessage({ id: 'shell.title' })}</h1>
      </div>
      <span className="dig-spacer" />
      {surface === 'popup' && (
        <button
          type="button"
          className="dig-iconbtn"
          data-testid="popout-fullview"
          aria-label={intl.formatMessage({ id: 'shell.popout' })}
          title={intl.formatMessage({ id: 'shell.popout' })}
          onClick={() => void popOutToFullpage(routeToHash(tab, walletView, networkView), true)}
        >
          ⤢
        </button>
      )}
      <button
        type="button"
        className="dig-iconbtn"
        data-testid="open-options"
        aria-label={intl.formatMessage({ id: 'shell.settings' })}
        title={intl.formatMessage({ id: 'shell.settings' })}
        onClick={openSettings}
      >
        ⚙
      </button>
    </header>
  );
}
