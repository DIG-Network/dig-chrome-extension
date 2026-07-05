import { FormattedMessage } from 'react-intl';
import { TABS, tabPanelId, tabTestId, type Tab } from '@/app/tabs';

/** Glyph + copy id for each top-shell tab. Glyphs are emoji (self-contained, no icon font). */
const TAB_META: Record<Tab, { glyph: string; labelId: string }> = {
  resolver: { glyph: '🧭', labelId: 'tab.resolver' },
  wallet: { glyph: '👛', labelId: 'tab.wallet' },
  shield: { glyph: '🛡️', labelId: 'tab.shield' },
  control: { glyph: '🎛️', labelId: 'tab.control' },
  apps: { glyph: '🧩', labelId: 'tab.apps' },
};

/**
 * The top-shell tab set, rendered as an ARIA tablist. `orientation` chooses the compact bottom bar
 * vs the expanded sidebar (same component, both surfaces). Each tab is a `role="tab"` with a stable
 * `data-testid` and controls its panel.
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
      aria-label="DIG extension sections"
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
            <FormattedMessage id={meta.labelId} />
          </button>
        );
      })}
    </nav>
  );
}
