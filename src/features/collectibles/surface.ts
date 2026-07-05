/**
 * Surface detection for the Collectibles grid (#56): the toolbar popup is size-constrained, so it
 * shows a capped grid + "See all ⤢"; the full-page `app.html` shows every collection. Pure (reads a
 * pathname) so it is unit-testable without a DOM.
 */

/** True when running in the full-page `app.html` surface (vs the constrained toolbar popup). */
export function isFullpageSurface(pathname: string = typeof location !== 'undefined' ? location.pathname : ''): boolean {
  return /app\.html(?:$|[?#])/.test(pathname);
}
