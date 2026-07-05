import { FormattedMessage } from 'react-intl';
import { BugReportButton } from '@dignetwork/components';

/**
 * Inline "Report a bug" entry (#65 B.2) — the shared `@dignetwork/components` reporter surfaced as a
 * quiet in-layout menu item (in the footer/status-bar) instead of a floating overlay. The component
 * only ships a floating launcher FAB, so we keep that FAB mounted (it carries the full reporting flow
 * — challenge/honeypot/timing + screenshot + console/network capture) but HIDE it via CSS
 * (`.digbr-launcher { display: none }`, see theme.css) and open its panel from this inline trigger by
 * programmatically clicking the (still-in-DOM) launcher. Repo is fixed to this extension.
 */
export function BugReportLink() {
  const openReporter = () => {
    // The shared reporter's floating launcher (stable aria-label "Report a bug"; class fallback).
    const fab = document.querySelector('[aria-label="Report a bug"].digbr-launcher, .digbr-launcher, [aria-label="Report a bug"]') as HTMLElement | null;
    fab?.click();
  };
  return (
    <span className="dig-bugreport-inline">
      <button type="button" className="dig-link" data-testid="bugreport-inline" onClick={openReporter}>
        🐞 <FormattedMessage id="bugreport.report" />
      </button>
      {/* The shared reporter — its floating FAB is hidden; this inline item opens its panel. */}
      <BugReportButton repo="dig-chrome-extension" />
    </span>
  );
}
