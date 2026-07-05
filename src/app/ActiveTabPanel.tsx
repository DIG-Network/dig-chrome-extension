import { useAppSelector } from '@/app/hooks';
import { tabPanelId, tabTestId, type Tab } from '@/app/tabs';
import { ResolverTab } from '@/features/resolver/ResolverTab';
import { WalletTab } from '@/features/wallet/WalletTab';
import { ShieldTab } from '@/features/shield/ShieldTab';
import { ControlTab } from '@/features/control/ControlTab';
import { AppsTab } from '@/features/apps/AppsTab';

/** Render the active top-shell tab's content in an ARIA tabpanel. Shared by both layouts. */
export function ActiveTabPanel() {
  const tab: Tab = useAppSelector((s) => s.ui.tab);
  return (
    <div id={tabPanelId(tab)} role="tabpanel" aria-labelledby={tabTestId(tab)} tabIndex={0} data-active-tab={tab}>
      {tab === 'resolver' && <ResolverTab />}
      {tab === 'wallet' && <WalletTab />}
      {tab === 'shield' && <ShieldTab />}
      {tab === 'control' && <ControlTab />}
      {tab === 'apps' && <AppsTab />}
    </div>
  );
}
