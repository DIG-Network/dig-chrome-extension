/**
 * First-run welcome page (welcome.html) — opened from `background.js`'s `onInstalled` handler on a
 * fresh install. Its only job is to funnel the new user into the rest of the DIG Network; every
 * destination comes from the shared {@link links} module so the funnels can never drift from the
 * popup. Pure DOM glue (no state), built by Vite as a standalone extension page under `src/entries/`.
 */
// Vendored DIG product type (Space Grotesk / Space Mono, `font-src 'self'`) so the FIRST page a new
// user sees matches the popup + full-screen wallet typography (§6.1 "one product"). welcome.html's
// inline CSS names these families with a system fallback until the woff2 load.
import '@/styles/fonts';
import { DIG_NETWORK_URL, DOCS_URL, DIG_BROWSER_URL, DISCORD_URL } from '@/lib/links';

/** Wire an anchor to open `url` in a new tab, keeping a real `href` so it works even without JS. */
function wire(id: string, url: string): void {
  const el = document.getElementById(id);
  if (!(el instanceof HTMLAnchorElement)) return;
  el.href = url; // real href so the link is meaningful even without JS
  el.addEventListener('click', (e) => {
    e.preventDefault();
    window.open(url, '_blank', 'noopener');
  });
}

wire('visitDigNetwork', DIG_NETWORK_URL);
wire('readTheDocs', DOCS_URL);
wire('getFullBrowser', DIG_BROWSER_URL);
wire('joinDiscord', DISCORD_URL);

// "Try it" affordances — make the one thing the extension is for concrete. Copy the example
// chia:// address (click the box or the Copy button).
const example = document.getElementById('exampleAddr');
const copyBtn = document.getElementById('copyExample');

function copyExample(): void {
  const text = example?.textContent?.trim() ?? '';
  if (!text) return;
  void navigator.clipboard?.writeText(text).catch(() => {});
  if (copyBtn) {
    const prev = copyBtn.textContent;
    copyBtn.textContent = 'Copied';
    setTimeout(() => {
      copyBtn.textContent = prev;
    }, 1200);
  }
}

example?.addEventListener('click', copyExample);
copyBtn?.addEventListener('click', copyExample);

// "Open a new tab to browse" — opens the DIG Home new-tab page (this extension overrides the new
// tab), so the user lands in the app directory. No URL → the browser opens the configured new-tab.
const openHome = document.getElementById('openDigHome');
openHome?.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs?.create({});
});
