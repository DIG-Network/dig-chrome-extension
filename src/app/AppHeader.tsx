import { FormattedMessage, useIntl } from 'react-intl';
import { useAppSelector } from '@/app/hooks';
import { routeToHash } from '@/app/tabs';
import { popOutToFullpage } from '@/lib/popout';
import { hasRuntime } from '@/lib/messaging';
import { StatusPill } from '@/components/StatusPill';
import { LiveStatusPill } from '@/features/control/LiveStatusSection';
import { WalletSyncPill } from '@/features/wallet/WalletSyncStatusBanner';
import { HeaderToolbarToggle } from '@/features/toolbar/HeaderToolbarToggle';
import type { Surface } from '@/app/layout';

/**
 * Top header: brand lockup + a persistent non-mainnet indicator (#108 guardrail — mainnet is real
 * funds, so a user must never be unsure which network they're viewing, on EITHER surface) + ⤢
 * pop-out (popup only) + DIG settings.
 */
export function AppHeader({ surface }: { surface: Surface }) {
  const intl = useIntl();
  const tab = useAppSelector((s) => s.ui.tab);
  const walletView = useAppSelector((s) => s.ui.walletView);
  const networkView = useAppSelector((s) => s.ui.networkView);
  const chainNetwork = useAppSelector((s) => s.ui.network);

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
      {chainNetwork !== 'mainnet' && (
        <StatusPill tone="warn" testid="network-badge">
          <FormattedMessage id="custody.network.testnet" />
        </StatusPill>
      )}
      {/* #239: live dig-node connection indicator — flips online/offline with no user action. */}
      <LiveStatusPill />
      {/* #373: first-class wallet SYNC indicator — syncing (catching up) / synced / disconnected,
          pushed live over the /ws transport (#372). Shows only on the wallet tab to keep the
          header uncluttered on the resolver/network surfaces. */}
      {tab === 'wallet' && <WalletSyncPill />}
      <span className="dig-spacer" />
      {/* #306 item 4 — the DIG toolbar switch, inline in the header (moved from the Home tab). */}
      <HeaderToolbarToggle />
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
