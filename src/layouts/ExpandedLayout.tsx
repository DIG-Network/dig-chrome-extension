import { useIntl } from 'react-intl';
import { AppFooter } from '@/components/AppFooter';
import { TabBar } from '@/components/TabBar';
import { ActiveTabPanel } from '@/app/ActiveTabPanel';
import { useAppDispatch, useAppSelector } from '@/app/hooks';
import { setTab } from '@/features/ui/uiSlice';
import { routeToHash } from '@/app/tabs';
import { popOutToFullpage } from '@/lib/popout';
import { hasRuntime } from '@/lib/messaging';
import type { Surface } from '@/app/layout';

/**
 * Expanded layout — `app.html` at ≥960px: a left sidebar (brand + the 5-tab set as a vertical
 * tablist + settings/pop-out low) and a centered content column rendering the active tab. Hosts the
 * FULL app (every tab), from the same route tree as the compact popup.
 */
export function ExpandedLayout({ surface }: { surface: Surface }) {
  const intl = useIntl();
  const dispatch = useAppDispatch();
  const tab = useAppSelector((s) => s.ui.tab);
  const walletView = useAppSelector((s) => s.ui.walletView);

  const openSettings = () => {
    if (!hasRuntime()) return;
    if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
  };

  return (
    <div className="dig-app dig-shell-expanded" data-surface={surface} data-layout="expanded" data-testid="popup-root">
      <aside className="dig-sidebar">
        <div className="dig-sidebar-brand">
          <span className="dig-brand-dot" aria-hidden="true" />
          {intl.formatMessage({ id: 'shell.title' })}
        </div>
        <TabBar active={tab} onSelect={(t) => dispatch(setTab(t))} orientation="sidebar" />
        <span style={{ flex: 1 }} />
        {surface === 'popup' && (
          <button
            type="button"
            className="dig-btn dig-btn--ghost"
            data-testid="popout-fullview"
            onClick={() => void popOutToFullpage(routeToHash(tab, walletView), true)}
          >
            ⤢ {intl.formatMessage({ id: 'shell.popout' })}
          </button>
        )}
        <button type="button" className="dig-btn dig-btn--ghost" data-testid="open-options" onClick={openSettings}>
          ⚙ {intl.formatMessage({ id: 'shell.settings' })}
        </button>
      </aside>
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
        <main className="dig-content-wide" role="main">
          <ActiveTabPanel />
        </main>
        <AppFooter />
      </div>
    </div>
  );
}
