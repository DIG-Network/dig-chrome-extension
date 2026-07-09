import { useIntl } from 'react-intl';
import { GET_XCH_URL } from '@/lib/links';
import { ExternalLink } from '@/components/ExternalLink';

/**
 * The "Get more XCH" affordance (#210) — a subtle link next to the XCH asset row that opens
 * chia.net's official buy-XCH page in a new tab. Unlike the $DIG row's multi-venue
 * {@link GetDigMenu} (#202), XCH has ONE canonical acquisition destination, so this is a plain
 * outbound link — no popover/menu — reusing {@link ExternalLink} (the same `chrome.tabs.create`
 * funnel idiom every other outbound link in the extension uses) and the `dig-getdig-trigger`
 * subtle-button styling for visual parity with the $DIG row's trigger.
 */
export function GetXchLink() {
  const intl = useIntl();
  return (
    <ExternalLink href={GET_XCH_URL} className="dig-getdig-trigger" testid="getxch-link">
      {intl.formatMessage({ id: 'wallet.getxch' })} <span aria-hidden="true">{'↗︎'}</span>
    </ExternalLink>
  );
}
