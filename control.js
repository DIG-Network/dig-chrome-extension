// Full-page DIG Control Panel onboarding landing (control.html).
//
// Shown when the Control Panel tab has no local dig-node to manage: a marketing/onboarding page
// that pitches installing the DIG node to run the full decentralized DIG Network. Pure DOM glue —
// it wires the CTAs to the shared ecosystem link constants (so destinations can't drift from the
// popup) and surfaces the extension version for bug-report attribution (§6.7). It resolves NO
// content and runs NO node logic (SoC: pure RPC consumer).

import { DIG_INSTALLER_URL } from './dig-node-status.mjs';
import { EXPLORE_URL, DOCS_URL, HUB_URL, BUGREPORT_URL } from './links.mjs';

function open(url) {
  if (chrome.tabs && chrome.tabs.create) chrome.tabs.create({ url });
  else window.open(url, '_blank', 'noopener');
}

function wire(id, url) {
  const el = document.getElementById(id);
  if (el) {
    el.href = url;
    el.addEventListener('click', (e) => { e.preventDefault(); open(url); });
  }
}

function setupVersion() {
  const meta = document.querySelector('meta[name="app-version"]');
  const raw = meta && meta.content ? meta.content.trim() : '';
  const version = raw && raw !== '__APP_VERSION__' ? raw : '';
  try { window.__APP_VERSION__ = version; } catch (e) { /* ignore */ }
  const el = document.getElementById('appVersion');
  if (el) el.textContent = version ? `v${version}` : '—';
}

function bugReportUrl() {
  const version = (window.__APP_VERSION__ || '').trim();
  const q = new URLSearchParams({ repo: 'dig-chrome-extension' });
  if (version) q.set('version', version);
  return `${BUGREPORT_URL}/?${q.toString()}`;
}

function init() {
  setupVersion();
  wire('installBtn', DIG_INSTALLER_URL);
  wire('learnBtn', DOCS_URL);
  wire('docsLink', DOCS_URL);
  wire('exploreLink', EXPLORE_URL);
  wire('hubLink', HUB_URL);
  wire('bugReportLink', bugReportUrl());
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
