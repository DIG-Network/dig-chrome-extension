import { AppHeader } from '@/components/AppHeader';
import { AppFooter } from '@/components/AppFooter';
import { TabBar } from '@/components/TabBar';
import { ActiveTabPanel } from '@/app/ActiveTabPanel';
import { useAppDispatch, useAppSelector } from '@/app/hooks';
import { setTab } from '@/features/ui/uiSlice';
import type { Surface } from '@/app/layout';

/**
 * Compact layout — the popup (and a narrow `app.html`): header, the active tab panel, the 5-tab
 * bottom bar, and a footer. One bottom bar; the wallet tab carries its own in-panel segmented
 * control. Renders every tab from the one route tree.
 */
export function CompactLayout({ surface }: { surface: Surface }) {
  const dispatch = useAppDispatch();
  const tab = useAppSelector((s) => s.ui.tab);
  return (
    <div className="dig-app" data-surface={surface} data-layout="compact">
      <AppHeader surface={surface} />
      <main className="dig-main" role="main" data-testid="popup-root">
        <ActiveTabPanel />
      </main>
      <TabBar active={tab} onSelect={(t) => dispatch(setTab(t))} orientation="bottom" />
      <AppFooter />
    </div>
  );
}
