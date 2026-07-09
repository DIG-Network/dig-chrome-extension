import { FormattedMessage } from 'react-intl';
import { useAppSelector } from '@/app/hooks';
import { DESKTOP_NAV, activeNavKey } from '@/layouts/desktopNav';

/**
 * The desktop workspace app-bar (#85) — a slim header above the content that names the active
 * section as the page-level `<h1>`, so the wide surface always has a clear title + a single top
 * heading landmark (§6.6 a11y). The title follows the SHARED route via {@link activeNavKey}; copy
 * reuses the sidebar's label ids (no new catalog entries).
 */
export function WalletTopbar() {
  const tab = useAppSelector((s) => s.ui.tab);
  const walletView = useAppSelector((s) => s.ui.walletView);
  const active = activeNavKey(tab, walletView);
  const item = DESKTOP_NAV.find((i) => i.key === active) ?? DESKTOP_NAV[0];

  return (
    <header className="dig-topbar" data-testid="wallet-topbar">
      <h1 className="dig-topbar-title" data-testid="topbar-title">
        <FormattedMessage id={item.labelId} />
      </h1>
    </header>
  );
}
