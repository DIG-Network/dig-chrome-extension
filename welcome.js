/**
 * First-run welcome page logic.
 *
 * Opened from background.js's onInstalled handler on a fresh install. Its only job is
 * to funnel the new user into the rest of the DIG Network. Destinations come from the
 * shared links.mjs so they can never drift from the popup's funnels.
 */
import { DIG_NETWORK_URL, DOCS_URL, DIG_BROWSER_URL } from './links.mjs';

function wire(id, url) {
  const el = document.getElementById(id);
  if (el) {
    el.href = url; // real href so the link is meaningful even without JS
    el.addEventListener('click', (e) => {
      e.preventDefault();
      window.open(url, '_blank', 'noopener');
    });
  }
}

wire('visitDigNetwork', DIG_NETWORK_URL);
wire('readTheDocs', DOCS_URL);
wire('getFullBrowser', DIG_BROWSER_URL);
