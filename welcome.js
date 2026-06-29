/**
 * First-run welcome page logic.
 *
 * Opened from background.js's onInstalled handler on a fresh install. Its only job is
 * to funnel the new user into the rest of the DIG Network. Destinations come from the
 * shared links.mjs so they can never drift from the popup's funnels.
 */
import { DIG_NETWORK_URL, DOCS_URL, DIG_BROWSER_URL, DISCORD_URL } from './links.mjs';

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
wire('joinDiscord', DISCORD_URL);

// "Try it" affordances — make the one thing the extension is for concrete.
// Copy the example chia:// address (click the box or the Copy button).
const example = document.getElementById('exampleAddr');
const copyBtn = document.getElementById('copyExample');
function copyExample() {
  const text = example && example.textContent ? example.textContent.trim() : '';
  if (!text) return;
  navigator.clipboard?.writeText(text).catch(() => {});
  if (copyBtn) {
    const prev = copyBtn.textContent;
    copyBtn.textContent = 'Copied';
    setTimeout(() => { copyBtn.textContent = prev; }, 1200);
  }
}
if (example) example.addEventListener('click', copyExample);
if (copyBtn) copyBtn.addEventListener('click', copyExample);

// "Open a new tab to browse" — opens the DIG Home new-tab page (this extension overrides
// the new tab), so the user lands in the app directory.
const openHome = document.getElementById('openDigHome');
if (openHome) {
  openHome.addEventListener('click', (e) => {
    e.preventDefault();
    // No URL → the browser opens the configured new-tab page (DIG Home).
    if (chrome.tabs && chrome.tabs.create) chrome.tabs.create({});
  });
}
