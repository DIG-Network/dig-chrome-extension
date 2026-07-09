import { AppFooter } from '@/components/AppFooter';
import { ActiveTabPanel } from '@/app/ActiveTabPanel';
import { WalletSidebar } from '@/layouts/WalletSidebar';
import { WalletTopbar } from '@/layouts/WalletTopbar';
import type { Surface } from '@/app/layout';

/**
 * Expanded layout — the desktop-class wallet workspace `app.html` renders at ≥960px (#85): a
 * persistent {@link WalletSidebar} (brand + the flattened section nav + network guardrail + settings)
 * beside a content column with a {@link WalletTopbar} app-bar, the width-using main pane, and the
 * shared {@link AppFooter}. The main pane renders the SAME {@link ActiveTabPanel} route tree as the
 * compact popup — one store, one set of feature containers; only the chrome around them changes. A
 * narrow `app.html` degrades to {@link CompactLayout} (the shell picks by width).
 */
export function ExpandedLayout({ surface }: { surface: Surface }) {
  return (
    <div className="dig-app dig-shell-expanded" data-surface={surface} data-layout="expanded" data-testid="popup-root">
      <WalletSidebar surface={surface} />
      <div className="dig-workspace">
        <WalletTopbar />
        <main className="dig-content-wide" role="main">
          <ActiveTabPanel />
        </main>
        <AppFooter />
      </div>
    </div>
  );
}
