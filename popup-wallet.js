// Popup wallet panel + verified line + per-origin consent UI + DIG settings link.
//
// Loaded as a module alongside popup.js (which keeps the existing RPC/host controls).
// This module owns the parity features added to reach the native DIG Browser experience:
//   - Wallet panel: balance (XCH + $DIG) + connect/disconnect (WalletConnect → Sage) + Get $DIG.
//   - Verified badge line: reflects the active tab's chia:// Merkle-verification state.
//   - Connection requests: approve/deny dapps' window.chia.connect() per origin.
//   - DIG settings link: opens the options page (dig-node host + RPC).

import * as wc from './wallet-wc.js';
import { getApprovedOrigins } from './wallet-broker.mjs';
import { digNodeInstallPrompt } from './dig-node-status.mjs';
import { ACTIONS } from './messages.mjs';
import { groupLedger, inclusionProofDisplay, executionProofDisplay } from './dig-ledger.mjs';
import { controlPanelViewModel } from './dig-control.mjs';

// Full native DIG Browser releases page — the Control Panel deep-links here for token-gated
// node management the extension can't drive under MV3 (no filesystem access to the control token).
const DIG_BROWSER_URL = 'https://github.com/DIG-Network/DIG_Browser/releases';

const TIBETSWAP_URL = 'https://v2.tibetswap.io/';
const $ = (id) => document.getElementById(id);

// DIG CAT asset id (TAIL) — the token whose balance fills the $DIG wallet row.
// Source of truth: SYSTEM.md "Canonical terminology & branding" / "DIG CAT payment".
const DIG_CAT_ASSET_ID = 'a406d3a9de984d03c9591c10d917593b434d5263cabe2b42f6b367df16832f81';

// One canonical verified label across popup / viewer / toolbar.
const VERIFIED_LABEL = 'Verified on Chia';
const VERIFIED_TOOLTIP = 'Merkle-proven against the on-chain root and decrypted on this device';

// ---- DIG Shields panel (verify line + per-resource proof ledger #134) ----
//
// Mirrors the native DIG Browser's dig://shields: the active tab's aggregate verification
// verdict, the capsule (storeId:rootHash) disclosure, and the per-resource inclusion-proof
// ledger grouped Verified (N) / Failed (M). Honest: execution proofs are NEVER green-checked
// (the read path fetches inclusion only — see dig-ledger.mjs executionProofDisplay).
async function refreshShieldPanel() {
  const line = $('verifyLine');
  const text = $('verifyText');
  const shieldDot = $('shieldDot');
  const capsuleWrap = $('shieldCapsule');
  const capsuleVal = $('shieldCapsuleValue');
  const summary = $('shieldLedgerSummary');
  const list = $('shieldLedgerList');
  const note = $('shieldNote');
  if (!line) return;

  let resp = null;
  try {
    resp = await chrome.runtime.sendMessage({ action: ACTIONS.getShieldLedger });
  } catch { resp = null; }

  const v = resp && resp.verification;
  // Aggregate verdict line + the toolbar Shield dot.
  if (v && v.state === 'verified') {
    line.className = 'verify-line verified';
    line.title = VERIFIED_TOOLTIP;
    if (text) text.textContent = VERIFIED_LABEL;
    line.setAttribute('data-verified', 'true');
    if (shieldDot) shieldDot.setAttribute('data-verified', 'true');
  } else if (v && v.state === 'failed') {
    line.className = 'verify-line failed';
    line.title = 'This content could not be proven against the on-chain root — do not trust it.';
    if (text) text.textContent = 'Verification failed';
    line.setAttribute('data-verified', 'false');
    if (shieldDot) shieldDot.setAttribute('data-verified', 'false');
  } else {
    line.className = 'verify-line';
    line.title = '';
    if (text) text.textContent = 'Open a chia:// page to see its proof status';
    line.setAttribute('data-verified', '');
    if (shieldDot) shieldDot.setAttribute('data-verified', '');
  }

  // Capsule disclosure (storeId:rootHash).
  const capsule = resp && resp.capsule;
  if (capsule && capsule.storeId && capsuleWrap && capsuleVal) {
    capsuleWrap.style.display = 'flex';
    capsuleVal.textContent = `${capsule.storeId}:${capsule.rootHash || 'latest'}`;
  } else if (capsuleWrap) {
    capsuleWrap.style.display = 'none';
  }

  // Per-resource proof ledger (grouped Verified/Failed).
  const entries = (resp && Array.isArray(resp.entries)) ? resp.entries : [];
  const group = (resp && resp.group) || groupLedger(entries);
  if (summary) {
    summary.innerHTML = '';
    if (group.empty) {
      summary.textContent = '';
    } else {
      const pass = document.createElement('span');
      pass.className = 'shield-pill passed';
      pass.textContent = `Verified ${group.passedCount}`;
      summary.appendChild(pass);
      if (group.failedCount > 0) {
        const fail = document.createElement('span');
        fail.className = 'shield-pill failed';
        fail.textContent = `Failed ${group.failedCount}`;
        summary.appendChild(fail);
      }
    }
  }
  if (list) {
    list.innerHTML = '';
    for (const e of entries) {
      const incl = inclusionProofDisplay(e);
      const exec = executionProofDisplay(e);
      const li = document.createElement('li');
      li.className = 'shield-ledger-item ' + (incl.verified ? 'passed' : 'failed');
      li.setAttribute('data-verified', incl.verified ? 'true' : 'false');
      const dot = document.createElement('span');
      dot.className = 'res-dot';
      const path = document.createElement('span');
      path.className = 'res-path';
      path.textContent = e.resourcePath || 'index.html';
      // Plain-language proof title; jargon (root/error) available via the tooltip.
      li.title = incl.verified
        ? `${incl.label}${incl.hasRoot ? ` (root ${incl.proofRoot.slice(0, 12)}…)` : ''}. ${exec.label}.`
        : `${incl.label}${incl.errorCode ? ` (${incl.errorCode})` : ''}. ${exec.label}.`;
      const ex = document.createElement('span');
      ex.className = 'res-exec';
      ex.textContent = exec.verified ? 'proof ✓' : '';
      li.append(dot, path, ex);
      list.appendChild(li);
    }
  }
  if (note) {
    if (group.empty) {
      note.textContent = 'Per-resource proof status appears here once you open a chia:// page in this tab.';
    } else if (group.allPassed) {
      note.textContent = 'Every resource on this page was Merkle-proven against the on-chain root and decrypted on this device.';
    } else {
      note.textContent = 'Some resources failed verification — they were not proven against the on-chain root. Do not trust them.';
    }
  }
}

// Backwards-compatible alias: other call sites (init, hash deep-link) still call this.
async function refreshVerifyLine() { return refreshShieldPanel(); }

// ---- DIG Control Panel (your dig-node) ----
//
// Mirrors the native DIG Browser's dig://control. Detects a local dig-node and renders either:
//   - MANAGE: the node's status (from the open control.status / read surface). The mutating
//     control.* methods are gated by an on-disk control token the extension can't read, so when
//     the node answers UNAUTHORIZED we honestly show node-present status and deep-link full
//     management to the native DIG Browser (which CAN present the token).
//   - INSTALL: a landing page encouraging install of the dig-node. Reads keep working via the
//     hosted network (rpc.dig.net) — stated honestly.
async function refreshControlPanel() {
  const panel = $('controlPanel');
  const body = $('controlBody');
  const controlDot = $('controlDot');
  if (!panel || !body) return;

  let view = null;
  try {
    view = await chrome.runtime.sendMessage({ action: ACTIONS.getControlStatus });
  } catch { view = null; }
  if (!view) {
    view = { mode: 'install', localNode: false, controlEndpoint: null, status: null, authRequired: false };
  }

  // The presentation decision is the tested pure view model (dig-control.mjs); the code below is
  // thin DOM glue over it.
  const vm = controlPanelViewModel(view);
  panel.setAttribute('data-mode', vm.mode);
  if (controlDot) controlDot.setAttribute('data-node', vm.nodeOnline ? 'true' : 'false');
  body.innerHTML = '';

  if (vm.mode === 'manage') {
    renderControlManage(body, vm);
  } else {
    renderControlInstall(body, vm);
  }
}

// Render the node-management view from the view model (node detected). Shows status stats when
// the node answered control.status; otherwise (token-gated) an honest "node detected" panel +
// deep-link to the native DIG Browser for full management.
function renderControlManage(body, vm) {
  const head = document.createElement('div');
  head.className = 'control-status-head';
  const title = document.createElement('span');
  title.className = 'control-title';
  title.textContent = 'Your dig-node';
  const state = document.createElement('span');
  state.className = 'control-state online';
  state.textContent = 'Running';
  state.setAttribute('data-testid', 'control-node-state');
  head.append(title, state);
  body.appendChild(head);

  body.appendChild(controlRow('Address', vm.base || ''));

  if (vm.hasStats) {
    const grid = document.createElement('div');
    grid.className = 'control-grid';
    grid.setAttribute('data-testid', 'control-stats');
    const stats = [
      ['Hosted stores', vm.stats.hostedStores],
      ['Cached capsules', vm.stats.cachedCapsules],
      ['Cache used', fmtBytes(vm.stats.cacheUsedBytes)],
      ['§21 sync', vm.stats.syncOn ? 'On' : 'Off'],
    ];
    for (const [label, value] of stats) {
      const cell = document.createElement('div');
      cell.className = 'control-stat';
      const l = document.createElement('span');
      l.className = 'control-stat-label';
      l.textContent = label;
      const v = document.createElement('span');
      v.className = 'control-stat-value';
      v.textContent = String(value);
      cell.append(l, v);
      grid.appendChild(cell);
    }
    body.appendChild(grid);
    body.appendChild(controlRow('Upstream', vm.upstream || ''));
  }

  // Honest about what the extension can drive: full (mutating) management needs the local control
  // token, which only an app with filesystem access (the native DIG Browser) can read.
  const note = document.createElement('p');
  note.setAttribute('data-testid', 'control-manage-note');
  note.textContent = vm.note;
  body.appendChild(note);

  if (vm.deepLinkBrowser) {
    const cta = document.createElement('button');
    cta.className = 'control-cta';
    cta.setAttribute('data-testid', 'control-get-browser');
    cta.textContent = 'Manage in the DIG Browser ↗';
    cta.addEventListener('click', () => { chrome.tabs.create({ url: DIG_BROWSER_URL }); window.close(); });
    body.appendChild(cta);
  }
}

// Render the install landing (no node detected) from the view model. Encourages installing the
// dig-node and is honest that reads keep working through the hosted network without one.
function renderControlInstall(body, vm) {
  const prompt = vm.install;
  const head = document.createElement('div');
  head.className = 'control-status-head';
  const title = document.createElement('span');
  title.className = 'control-title';
  title.textContent = prompt.title;
  const state = document.createElement('span');
  state.className = 'control-state offline';
  state.textContent = 'No local node';
  state.setAttribute('data-testid', 'control-node-state');
  head.append(title, state);
  body.appendChild(head);

  const p = document.createElement('p');
  p.setAttribute('data-testid', 'control-install-note');
  p.textContent = prompt.body;
  body.appendChild(p);

  const cta = document.createElement('a');
  cta.className = 'control-cta';
  cta.setAttribute('data-testid', 'control-install');
  cta.href = prompt.installUrl;
  cta.textContent = prompt.installLabel + ' ↗';
  cta.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: prompt.installUrl });
    window.close();
  });
  body.appendChild(cta);

  // Honest read-fallback line: content keeps working without a node.
  const fb = document.createElement('p');
  fb.setAttribute('data-testid', 'control-read-fallback');
  fb.textContent = vm.readFallbackLine;
  body.appendChild(fb);
}

/** A labelled key/value row for the control panel. */
function controlRow(label, value) {
  const row = document.createElement('div');
  row.className = 'control-row';
  const l = document.createElement('span');
  l.className = 'control-row-label';
  l.textContent = label;
  const v = document.createElement('span');
  v.className = 'control-row-value';
  v.textContent = value;
  row.append(l, v);
  return row;
}

function fmtBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0; let x = v;
  while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
  return `${x.toFixed(i ? 1 : 0)} ${u[i]}`;
}

// ---- Toolbar action switcher (Wallet · Shield · Control Panel) ----
//
// One panel visible at a time; the active button reflects aria-pressed=true + data-active so an
// agent can read the open action. Wallet is the default open panel on popup load.
const PANELS = {
  wallet: 'walletPanel',
  shield: 'shieldPanel',
  control: 'controlPanel',
};

function showPanel(name) {
  for (const [panel, elId] of Object.entries(PANELS)) {
    const el = $(elId);
    if (el) el.style.display = panel === name ? (panel === 'wallet' ? 'flex' : 'flex') : 'none';
  }
  // Reflect the active button.
  document.querySelectorAll('.toolbar-btn').forEach((btn) => {
    const isActive = btn.getAttribute('data-panel') === name;
    btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    if (isActive) btn.setAttribute('data-active', 'true');
    else btn.removeAttribute('data-active');
  });
  // Lazily refresh the panel being shown.
  if (name === 'shield') refreshShieldPanel();
  if (name === 'control') refreshControlPanel();
  if (name === 'wallet') refreshWalletPanel();
}

function setupToolbar() {
  document.querySelectorAll('.toolbar-btn').forEach((btn) => {
    btn.addEventListener('click', () => showPanel(btn.getAttribute('data-panel')));
  });
}

// ---- Wallet panel ----
function fmtAmount(v) {
  if (v == null) return '—';
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: 6 }) : '—';
}

async function refreshWalletPanel() {
  const state = $('walletState');
  const balances = $('walletBalances');
  const addrEl = $('walletAddress');
  const connectBtn = $('walletConnectBtn');
  const disconnectBtn = $('walletDisconnectBtn');
  if (!state) return;

  const conn = await wc.getConnection();
  if (conn && conn.connected) {
    state.textContent = 'Connected';
    state.classList.add('connected');
    if (addrEl && conn.address) {
      addrEl.style.display = 'block';
      addrEl.textContent = conn.address;
    }
    if (balances) balances.style.display = 'flex';
    if (connectBtn) connectBtn.style.display = 'none';
    if (disconnectBtn) disconnectBtn.style.display = 'block';
    refreshBalances(conn);
  } else {
    state.textContent = 'Not connected';
    state.classList.remove('connected');
    if (addrEl) addrEl.style.display = 'none';
    if (balances) balances.style.display = 'none';
    if (connectBtn) connectBtn.style.display = 'block';
    if (disconnectBtn) disconnectBtn.style.display = 'none';
  }
}

async function refreshBalances(conn) {
  const xch = $('walletXch');
  const dig = $('walletDig');
  // Best-effort balances over the live session (popup-only; Sage must be reachable).
  try {
    const xchBal = await wc.request('chip0002_getAssetBalance', { type: null, assetId: null });
    if (xch) xch.textContent = fmtAmount(xchBal && (xchBal.confirmed ?? xchBal.spendable ?? xchBal));
  } catch {
    if (xch) xch.textContent = '—';
  }
  // $DIG CAT balance — query the DIG TAIL so the row shows a real number instead of a
  // dead "—". Falls back to "—" only when the wallet can't report it.
  try {
    const digBal = await wc.request('chip0002_getAssetBalance', { type: 'cat', assetId: DIG_CAT_ASSET_ID });
    if (dig) dig.textContent = fmtAmount(digBal && (digBal.confirmed ?? digBal.spendable ?? digBal));
  } catch {
    if (dig) dig.textContent = '—';
  }
}

function setNote(msg, isError) {
  const note = $('walletNote');
  if (!note) return;
  note.textContent = msg || '';
  note.className = 'wallet-note' + (isError ? ' error' : '');
}

async function startConnect() {
  const pairing = $('walletPairing');
  const uriInput = $('walletPairingUri');
  setNote('Opening WalletConnect…');
  try {
    const { uri, approval } = await wc.connect();
    if (pairing && uriInput) {
      pairing.style.display = 'flex';
      uriInput.value = uri;
    }
    setNote('Approve the connection in Sage to finish.');
    await approval();
    if (pairing) pairing.style.display = 'none';
    setNote('Wallet connected.');
    await refreshWalletPanel();
  } catch (e) {
    setNote((e && e.message) || 'Could not connect wallet.', true);
  }
}

async function doDisconnect() {
  try {
    await wc.disconnect();
    setNote('Wallet disconnected.');
    await refreshWalletPanel();
  } catch (e) {
    setNote((e && e.message) || 'Disconnect failed.', true);
  }
}

// ---- dig-node install prompt ----
// Shown ONLY when no local dig-node is reachable (dig.local or localhost:port). It is a soft
// nudge — the extension still resolves chia:// via the hosted network without a local node —
// so the banner explains the upside and links to the universal installer. One copy source
// (dig-node-status.mjs) so the popup, options page, and error path never drift.
async function refreshDigNodeBanner() {
  const banner = $('digNodeBanner');
  if (!banner) return;
  let reachable = false;
  try {
    const r = await chrome.runtime.sendMessage({ action: 'getDigNodeStatus' });
    reachable = !!(r && r.reachable);
  } catch {
    // Treat a failed probe as "not reachable" → show the prompt.
    reachable = false;
  }
  if (reachable) {
    banner.style.display = 'none';
    return;
  }
  const prompt = digNodeInstallPrompt();
  const title = $('digNodeTitle');
  const body = $('digNodeBody');
  const install = $('digNodeInstall');
  if (title) title.textContent = prompt.title;
  if (body) body.textContent = prompt.body;
  if (install) {
    install.textContent = prompt.installLabel;
    install.href = prompt.installUrl;
    install.onclick = (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: prompt.installUrl });
      window.close();
    };
  }
  banner.style.display = 'flex';
}

// ---- Per-origin connection requests ----
async function refreshConnReqs() {
  const section = $('connreqSection');
  const list = $('connreqList');
  if (!section || !list) return;
  let pending = [];
  let approved = {};
  try {
    const out = await chrome.storage.local.get('wallet.pendingOrigins');
    pending = Array.isArray(out['wallet.pendingOrigins']) ? out['wallet.pendingOrigins'] : [];
    approved = await getApprovedOrigins(chrome.storage.local);
  } catch { /* ignore */ }
  const unapproved = pending.filter((o) => !(approved[o] && approved[o].approved));
  if (unapproved.length === 0) {
    section.style.display = 'none';
    list.textContent = '';
    return;
  }
  section.style.display = 'flex';
  list.textContent = '';
  for (const origin of unapproved) {
    const item = document.createElement('div');
    item.className = 'connreq-item';
    const o = document.createElement('span');
    o.className = 'connreq-origin';
    o.textContent = origin;
    const allow = document.createElement('button');
    allow.className = 'connreq-btn connreq-allow';
    allow.textContent = 'Allow';
    allow.addEventListener('click', () => respondConsent(origin, true));
    const deny = document.createElement('button');
    deny.className = 'connreq-btn connreq-deny';
    deny.textContent = 'Deny';
    deny.addEventListener('click', () => respondConsent(origin, false));
    item.append(o, allow, deny);
    list.appendChild(item);
  }
}

async function respondConsent(origin, approved) {
  try {
    await chrome.runtime.sendMessage({ action: 'walletConsent', origin, approved });
  } catch { /* ignore */ }
  await refreshConnReqs();
}

function init() {
  // Wire wallet actions.
  const connectBtn = $('walletConnectBtn');
  const disconnectBtn = $('walletDisconnectBtn');
  const getDig = $('getDigLink');
  const pairCopy = $('walletPairingCopy');
  const openOptions = $('openOptionsLink');

  if (connectBtn) connectBtn.addEventListener('click', startConnect);
  if (disconnectBtn) disconnectBtn.addEventListener('click', doDisconnect);
  if (getDig) {
    getDig.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: TIBETSWAP_URL });
      window.close();
    });
  }
  if (pairCopy) {
    pairCopy.addEventListener('click', () => {
      const uriInput = $('walletPairingUri');
      if (uriInput && uriInput.value) {
        navigator.clipboard?.writeText(uriInput.value).catch(() => {});
        uriInput.select();
      }
    });
  }
  if (openOptions) {
    openOptions.addEventListener('click', (e) => {
      e.preventDefault();
      if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
      else chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
    });
  }

  // Fulfil dapp requests over the relay while the popup is open.
  try { wc.listenForBrokeredRequests(); } catch { /* no WC bundle yet */ }

  // Toolbar: Wallet · Shield · Control Panel. Wire the switcher and open the panel matching the
  // deep-link hash (#shield / #control), defaulting to Wallet.
  setupToolbar();
  const initial =
    location.hash === '#shield' ? 'shield' :
    location.hash === '#control' ? 'control' : 'wallet';
  showPanel(initial);

  // Prime the toolbar status dots so the Shield (verified) + Control (node present) verdicts are
  // visible without first opening each panel — an at-a-glance, agent-readable state.
  refreshShieldPanel();
  refreshControlPanel();

  refreshWalletPanel();
  refreshConnReqs();
  refreshDigNodeBanner();

  // If deep-linked to #wallet (from the NTP wallet pill), scroll the panel into view.
  if (location.hash === '#wallet') {
    $('walletConnectBtn')?.scrollIntoView({ block: 'center' });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
