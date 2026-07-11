import { AppHeader } from '@/components/AppHeader';
import { AppFooter } from '@/components/AppFooter';
import { TabBar } from '@/components/TabBar';
import { ActiveTabPanel } from '@/app/ActiveTabPanel';
import { useAppDispatch, useAppSelector } from '@/app/hooks';
import { setTab } from '@/features/ui/uiSlice';
import type { Surface } from '@/app/layout';

/**
 * Compact layout — a phone (the popup + a narrow `app.html`): a status-bar-feel header, ONE
 * scrolling content area (the active mobile-OS screen + a subtle footer), and the STICKY phone
 * bottom nav pinned to the viewport bottom (always visible; only the content scrolls). The footer
 * lives inside the scroll area so the version stays visible without floating over content. Renders
 * every screen from the one route tree.
 */
export function CompactLayout({ surface }: { surface: Surface }) {
  const dispatch = useAppDispatch();
  const tab = useAppSelector((s) => s.ui.tab);
  return (
    <div className="dig-app" data-surface={surface} data-layout="compact">
      <AppHeader surface={surface} />
      <main className="dig-main" role="main" data-testid="popup-root">
        <ActiveTabPanel />
        <AppFooter />
      </main>
      <TabBar active={tab} onSelect={(t) => dispatch(setTab(t))} orientation="bottom" />
    </div>
  );
}
