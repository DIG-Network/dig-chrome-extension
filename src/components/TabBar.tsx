import { FormattedMessage } from 'react-intl';
import { TABS, tabPanelId, tabTestId, type Tab } from '@/app/tabs';

/** Glyph + copy id for each top-level screen. Glyphs are emoji (self-contained, no icon font).
 *  The fullscreen-only tabs (peers/advertise) carry metadata for completeness but are not rendered
 *  in the compact bottom nav (this component maps over the compact {@link TABS} set only). */
const TAB_META: Record<Tab, { glyph: string; labelId: string }> = {
  home: { glyph: '🏠', labelId: 'tab.home' },
  wallet: { glyph: '👛', labelId: 'tab.wallet' },
  apps: { glyph: '🧩', labelId: 'tab.apps' },
  network: { glyph: '🌐', labelId: 'tab.network' },
  peers: { glyph: '🛰️', labelId: 'tab.peers' },
  advertise: { glyph: '📣', labelId: 'tab.advertise' },
};

/**
 * The mobile-OS navigation, rendered as an ARIA tablist. `orientation` chooses the compact phone
 * bottom bar vs the expanded (tablet/desktop-OS) side rail — same component, both surfaces. Each
 * screen is a `role="tab"` with a stable `data-testid`, a squircle glyph, and its label.
 */
export function TabBar({
  active,
  onSelect,
  orientation,
}: {
  active: Tab;
  onSelect: (tab: Tab) => void;
  orientation: 'bottom' | 'sidebar';
}) {
  return (
    <nav
      className={orientation === 'bottom' ? 'dig-tabbar' : 'dig-sidebar-tabs'}
      role="tablist"
      aria-label="DIG sections"
      aria-orientation={orientation === 'sidebar' ? 'vertical' : 'horizontal'}
    >
      {TABS.map((tab) => {
        const selected = tab === active;
        const meta = TAB_META[tab];
        return (
          <button
            key={tab}
            type="button"
            role="tab"
            className="dig-tab"
            aria-selected={selected}
            aria-controls={tabPanelId(tab)}
            tabIndex={selected ? 0 : -1}
            data-testid={tabTestId(tab)}
            data-tab={tab}
            onClick={() => onSelect(tab)}
          >
            <span className="dig-tab-glyph" aria-hidden="true">
              {meta.glyph}
            </span>
            <span className="dig-tab-label">
              <FormattedMessage id={meta.labelId} />
            </span>
          </button>
        );
      })}
    </nav>
  );
}
