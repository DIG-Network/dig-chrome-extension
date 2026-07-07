import type { ReactNode } from 'react';

/**
 * ViewHeader (#166) — the shared sticky-top-header primitive for a "screen"-style view (Send,
 * Receive, NFT/DID detail, offers, …): pins the back/close action + an optional title to the top
 * of the enclosing scroll container (`.dig-main`, the extension's ONE scrollable region — see
 * `theme.css`), so it stays reachable at ANY scroll position instead of being pushed below a
 * growable body (a long form, a coin picker, an offer summary) — the #166 bug.
 *
 * Contract: render this as the FIRST element of a screen; the screen's own scrollable content
 * (typically a `.dig-card` section) goes right after it, never nested inside it — nesting it
 * inside a bordered/rounded card would make the sticky strip visually clip against the card's own
 * background when it pins mid-scroll. Each caller keeps its OWN back-label copy/id (so existing
 * translated strings like `nft.detail.back` are reused verbatim) and passes it as `backLabel`.
 */
export function ViewHeader({
  title,
  titleId,
  onBack,
  backLabel,
  backTestId = 'view-header-back',
  testid = 'view-header',
}: {
  /** The screen's title, rendered as an `<h2>`. Omit for a back-only header (e.g. NFT/DID detail,
   * which keep their own dynamic title below, next to the preview image). */
  title?: ReactNode;
  /** `id` for the title `<h2>`, so a wrapping `<section aria-labelledby>` can still reference it. */
  titleId?: string;
  /** Navigate back / close this screen. Omit to render a title-only bar (no back affordance). */
  onBack?: () => void;
  /** The back button's visible label — a `FormattedMessage`/string; every screen keeps its own copy. */
  backLabel?: ReactNode;
  backTestId?: string;
  testid?: string;
}) {
  return (
    <header className="dig-view-header" data-testid={testid}>
      {onBack && (
        <button type="button" className="dig-link dig-view-header__back" data-testid={backTestId} onClick={onBack}>
          {backLabel}
        </button>
      )}
      {title !== undefined && (
        <h2 className="dig-heading dig-view-header__title" id={titleId}>
          {title}
        </h2>
      )}
    </header>
  );
}
