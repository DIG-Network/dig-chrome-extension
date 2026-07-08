import { useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { GET_DIG_SOURCES } from '@/lib/links';
import { ExternalLink } from '@/components/ExternalLink';

/** Per-venue translated label + one-line hint, keyed by the {@link GET_DIG_SOURCES} entry's `name`.
 * Venue names themselves are brand literals (never translated, like "SpaceScan"/"CoinGecko"
 * elsewhere in this codebase) — only the descriptive hint is localized. */
const VENUE_MESSAGE_IDS: Record<string, string> = {
  TibetSwap: 'wallet.getdig.hint.tibetswap',
  dexie: 'wallet.getdig.hint.dexie',
  '9mm.pro': 'wallet.getdig.hint.9mm',
};

/**
 * The "Get more $DIG" affordance (#202) — a subtle trigger next to the $DIG asset row that opens a
 * small accessible menu of the three canonical acquisition venues, in the SAME order + with the SAME
 * URLs as {@link GET_DIG_SOURCES} (mirrors hub's `GetDigMenu` so every DIG surface funnels a user to
 * the identical set of venues). Each entry reuses {@link ExternalLink} so it opens in a new tab via
 * the same `chrome.tabs.create` idiom every other outbound link in the extension uses.
 *
 * A self-contained popover (not the heavier {@link Sheet} modal used for Send/Receive) — three links
 * don't warrant a full-screen dialog; it closes on a second trigger click, Escape, or an outside
 * click, and is keyboard-reachable (`role="menu"`/`menuitem`, `aria-haspopup`/`aria-expanded`).
 */
export function GetDigMenu() {
  const intl = useIntl();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onOutside);
    return () => document.removeEventListener('mousedown', onOutside);
  }, [open]);

  return (
    <span className="dig-getdig" ref={ref}>
      <button
        type="button"
        className="dig-getdig-trigger"
        data-testid="getdig-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        title={intl.formatMessage({ id: 'wallet.getdig' })}
        onClick={() => setOpen((v) => !v)}
      >
        {intl.formatMessage({ id: 'wallet.getdig.open' })} <span aria-hidden="true">↗</span>
      </button>
      {open && (
        <div
          className="dig-getdig-menu"
          role="menu"
          aria-label={intl.formatMessage({ id: 'wallet.getdig' })}
          data-testid="getdig-menu"
          onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
        >
          {GET_DIG_SOURCES.map((source) => (
            <ExternalLink
              key={source.name}
              href={source.url}
              className="dig-getdig-item"
              testid={`getdig-item-${source.name}`}
              role="menuitem"
              onClick={() => setOpen(false)}
            >
              <span className="dig-getdig-item-name">{source.name}</span>
              <span className="dig-getdig-item-hint">
                {intl.formatMessage({ id: VENUE_MESSAGE_IDS[source.name] ?? 'wallet.getdig' })}
              </span>
            </ExternalLink>
          ))}
        </div>
      )}
    </span>
  );
}
