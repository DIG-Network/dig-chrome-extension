import { useAppSelector } from '@/app/hooks';
import { tabPanelId, tabTestId, type Tab } from '@/app/tabs';
import { HomeScreen } from '@/features/home/HomeScreen';
import { WalletTab } from '@/features/wallet/WalletTab';
import { AppsTab } from '@/features/apps/AppsTab';
import { NetworkScreen } from '@/features/network/NetworkScreen';
import { PeersTab } from '@/features/peers/PeersTab';
import { AdvertiseTab } from '@/features/advertise/AdvertiseTab';
import { TippingTab } from '@/features/tipping/TippingTab';
import { SecurityTab } from '@/features/security/SecurityTab';
import { UpdatesTab } from '@/features/updates/UpdatesTab';

/**
 * Render the active mobile-OS screen in an ARIA tabpanel. The `key={tab}` remounts on switch so the
 * app-open transition (CSS `dig-screen-enter`) plays each time you open a screen. Shared by both
 * layouts (compact phone + expanded tablet/desktop-OS).
 */
export function ActiveTabPanel() {
  const tab: Tab = useAppSelector((s) => s.ui.tab);
  return (
    <div
      key={tab}
      id={tabPanelId(tab)}
      role="tabpanel"
      aria-labelledby={tabTestId(tab)}
      tabIndex={0}
      data-active-tab={tab}
      className="dig-screen"
    >
      {tab === 'home' && <HomeScreen />}
      {tab === 'wallet' && <WalletTab />}
      {tab === 'apps' && <AppsTab />}
      {tab === 'network' && <NetworkScreen />}
      {tab === 'peers' && <PeersTab />}
      {tab === 'advertise' && <AdvertiseTab />}
      {tab === 'tipping' && <TippingTab />}
      {tab === 'security' && <SecurityTab />}
      {tab === 'updates' && <UpdatesTab />}
    </div>
  );
}
