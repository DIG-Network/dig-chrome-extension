/**
 * DIG Home (new-tab override, newtab.html) — a search⇄app-store switcher, the ecosystem app
 * directory, and an omnibox that routes store ids / chia:// URLs to the DIG Network and everything
 * else to web search. The directory + omnibox classifier come from the shared `#shared/apps.mjs`
 * so they're a single (unit-tested) source of truth. Pure DOM + chrome.* glue, built by Vite as a
 * standalone extension page under `src/entries/`.
 *
 * chia:// navigation: an extension page can't navigate the tab to a chia:// URL (no registered
 * scheme), so we hand it to the background SW (`navigateToDigUrl`), which redirects the tab to the
 * in-extension dig-viewer (verified + decrypted render).
 */
import { DIG_APPS, DIG_HOME_FOOTER_LINKS, classifyOmnibox, omniboxTarget } from '#shared/apps.mjs';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T | null =>
  document.getElementById(id) as T | null;

/** Render the app-directory cards from DIG_APPS. */
function renderApps(): void {
  const grid = $('appGrid');
  if (!grid) return;
  for (const app of DIG_APPS) {
    const a = document.createElement('a');
    a.className = 'app';
    a.href = app.url;
    a.target = '_blank';
    a.rel = 'noopener';

    const row = document.createElement('div');
    row.className = 'row';
    const well = document.createElement('div');
    well.className = 'well';
    well.textContent = app.glyph;
    const meta = document.createElement('div');
    const nm = document.createElement('div');
    nm.className = 'nm';
    nm.textContent = app.name;
    const host = document.createElement('div');
    host.className = 'host';
    host.textContent = app.host;
    meta.append(nm, host);
    row.append(well, meta);

    const ds = document.createElement('p');
    ds.className = 'ds';
    ds.textContent = app.blurb;

    const chip = document.createElement('span');
    chip.className = 'chip' + (app.dig ? ' dig' : '');
    chip.textContent = `${app.chip} ↗`;

    a.append(row, ds, chip);
    grid.appendChild(a);
  }
}

/** Render footer links from DIG_HOME_FOOTER_LINKS. */
function renderFooter(): void {
  const footer = $('footerLinks');
  if (!footer) return;
  for (const l of DIG_HOME_FOOTER_LINKS) {
    const a = document.createElement('a');
    a.href = l.url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = l.label;
    footer.appendChild(a);
  }
}

/** Search ⇄ App Store switcher. */
function wireSwitcher(): void {
  const tabApps = $('tabApps');
  const tabSearch = $('tabSearch');
  const panelApps = $('panelApps');
  const panelSearch = $('panelSearch');
  const q = $<HTMLInputElement>('q');
  if (!tabApps || !tabSearch || !panelApps || !panelSearch) return;
  function select(which: 'apps' | 'search'): void {
    const apps = which === 'apps';
    tabApps!.setAttribute('aria-selected', String(apps));
    tabSearch!.setAttribute('aria-selected', String(!apps));
    panelApps!.hidden = !apps;
    panelSearch!.hidden = apps;
    if (!apps && q) q.focus();
  }
  tabApps.addEventListener('click', () => select('apps'));
  tabSearch.addEventListener('click', () => select('search'));
}

/** Navigate the current tab. chia:// goes through the background SW; everything else direct. */
function navigate(url: string): void {
  if (/^chia:\/\//i.test(url)) {
    // Hand chia:// to the background SW → dig-viewer (verified + decrypted render).
    chrome.runtime.sendMessage({ action: 'navigateToDigUrl', url }, () => {
      // The background redirects this tab; ignore the (often closed) response port.
      void chrome.runtime.lastError;
    });
    return;
  }
  window.location.href = url;
}

/** Omnibox: reflect intent as the user types, route on submit. */
function wireOmnibox(): void {
  const form = $<HTMLFormElement>('omni');
  const q = $<HTMLInputElement>('q');
  const mode = $('mode');
  const lead = $('lead');
  const goBtn = $('goBtn');
  if (!form || !q || !mode || !lead || !goBtn) return;

  function reflect(): void {
    const k = classifyOmnibox(q!.value);
    if (k === 'dig') {
      mode!.className = 'mode dig';
      mode!.innerHTML = 'Opens on the <b>DIG Network</b> &mdash; verified on Chia';
      lead!.innerHTML = '&#9670;';
      goBtn!.textContent = 'Open';
    } else if (k === 'url') {
      mode!.className = 'mode';
      mode!.innerHTML = 'Go to <b>' + q!.value.trim().replace(/[<>&]/g, '') + '</b>';
      lead!.innerHTML = '&#127760;';
      goBtn!.textContent = 'Go';
    } else {
      mode!.className = 'mode';
      mode!.innerHTML = 'Searches the web with <b>DuckDuckGo</b>';
      lead!.innerHTML = '&#128269;';
      goBtn!.textContent = 'Search';
    }
  }
  q.addEventListener('input', reflect);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = (q.value || '').trim();
    if (!v) return;
    navigate(omniboxTarget(v));
  });
}

/** External brand/publish links: open in a new tab from the extension page. */
function wireExternalLinks(): void {
  document.querySelectorAll<HTMLAnchorElement>('a[data-ext-link]').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs?.create({ url: a.href });
    });
  });
}

/** xch1abcd…wxyz */
function shortAddr(a: string): string {
  return a.length > 14 ? `${a.slice(0, 8)}…${a.slice(-4)}` : a;
}

/** Reflect wallet connection state (label + dot) from the shared WC connection store. */
async function reflectWallet(): Promise<void> {
  const wallet = $('wallet');
  const label = $('walletLabel');
  if (!wallet) return;
  let connected = false;
  let address = '';
  try {
    const { 'wallet.connection': conn } = await chrome.storage.local.get('wallet.connection');
    const c = conn as { connected?: boolean; address?: string } | undefined;
    connected = !!c?.connected;
    address = c?.address || '';
  } catch {
    /* storage unavailable — show the default disconnected state */
  }
  if (connected) {
    wallet.classList.add('connected');
    if (label) label.textContent = address ? shortAddr(address) : 'Connected';
  } else {
    wallet.classList.remove('connected');
    if (label) label.textContent = 'Wallet';
  }
}

function init(): void {
  renderApps();
  renderFooter();
  wireSwitcher();
  wireOmnibox();
  wireExternalLinks();
  void reflectWallet();

  // The wallet pill opens the extension popup's wallet panel (where connect lives).
  const wallet = $('wallet');
  if (wallet) {
    wallet.addEventListener('click', (e) => {
      e.preventDefault();
      // Popups can't be opened programmatically reliably from a page; deep-link to the wallet view
      // in a tab as a fallback that works in every Chromium/Firefox build.
      chrome.tabs?.create({ url: chrome.runtime.getURL('popup.html#wallet') });
    });
  }

  // Keep the wallet pill fresh if the connection changes while DIG Home is open.
  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area === 'local' && changes['wallet.connection']) void reflectWallet();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
