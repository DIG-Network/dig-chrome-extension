import { FormattedMessage, useIntl } from 'react-intl';
import { StatusPill } from '@/components/StatusPill';
import { useAppDispatch, useAppSelector } from '@/app/hooks';
import { setTab, setWalletView } from '@/features/ui/uiSlice';
import { hasRuntime } from '@/lib/messaging';
import { DESKTOP_NAV, activeNavKey, type DesktopNavItem } from '@/layouts/desktopNav';
import type { Surface } from '@/app/layout';

/**
 * The desktop wallet sidebar (#85) — the persistent left nav of the fullscreen `app.html` workspace.
 * It flattens the wallet's segmented sub-views ({@link DESKTOP_NAV}) into one-click entries so the
 * whole wallet is reachable without scrolling one stacked stream. Every item drives the SHARED route
 * state (`tab` + `walletView`) via the same actions the compact popup uses — one store, no forked
 * navigation. Rendered as an ARIA `navigation`/tablist-free button list with `aria-current` on the
 * active item and stable `data-testid="nav-<key>"` selectors (accessible AND agent-drivable, §6.2).
 */
export function WalletSidebar({ surface }: { surface: Surface }) {
  const intl = useIntl();
  const dispatch = useAppDispatch();
  const tab = useAppSelector((s) => s.ui.tab);
  const walletView = useAppSelector((s) => s.ui.walletView);
  const chainNetwork = useAppSelector((s) => s.ui.network);
  const active = activeNavKey(tab, walletView);

  const go = (item: DesktopNavItem) => {
    dispatch(setTab(item.tab));
    if (item.tab === 'wallet' && item.walletView) dispatch(setWalletView(item.walletView));
  };

  const openSettings = () => {
    if (!hasRuntime()) return;
    if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
    else if (chrome.tabs) void chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
  };

  return (
    <aside className="dig-sidebar" data-surface={surface}>
      <div className="dig-sidebar-brand">
        <span className="dig-brand-dot" aria-hidden="true" />
        {intl.formatMessage({ id: 'shell.wallet.title' })}
      </div>

      <nav className="dig-sidebar-nav" aria-label={intl.formatMessage({ id: 'shell.nav.label' })}>
        {DESKTOP_NAV.map((item) => {
          const selected = item.key === active;
          return (
            <button
              key={item.key}
              type="button"
              className="dig-navitem"
              data-testid={`nav-${item.key}`}
              data-nav={item.key}
              aria-current={selected ? 'page' : undefined}
              onClick={() => go(item)}
            >
              <span className="dig-navitem-glyph" aria-hidden="true">
                {item.glyph}
              </span>
              <span className="dig-navitem-label">
                <FormattedMessage id={item.labelId} />
              </span>
            </button>
          );
        })}
      </nav>

      <span className="dig-sidebar-fill" />

      {/* #108 guardrail: mainnet is real funds — a persistent non-mainnet indicator on EVERY surface.
          The desktop sidebar has no AppHeader, so it carries its own copy of the badge. */}
      {chainNetwork !== 'mainnet' && (
        <div className="dig-sidebar-badge">
          <StatusPill tone="warn" testid="network-badge">
            <FormattedMessage id="custody.network.testnet" />
          </StatusPill>
        </div>
      )}

      <button type="button" className="dig-navitem dig-navitem--muted" data-testid="open-options" onClick={openSettings}>
        <span className="dig-navitem-glyph" aria-hidden="true">
          ⚙
        </span>
        <span className="dig-navitem-label">{intl.formatMessage({ id: 'shell.settings' })}</span>
      </button>
    </aside>
  );
}
