// Popup controller (module side) — the 4-tab surface: Resolver · Wallet · Shield · Control Panel.
//
// Loaded as an ES module alongside popup.js (the classic script that owns the resolver toggle,
// chia:// open box, ecosystem funnels, Explore link, and the version footer). This module owns
// everything that needs an ES import (the pure view-models):
//   - Tab routing (tabs.mjs) — the four-tab switch + hash deep-link, ARIA + roving-tabindex.
//   - Resolver §5.3 node-config — the custom-node override + the "Resolving via" verdict
//     (resolve-status.mjs over the getDigNodeStatus probe).
//   - Wallet — balances (Sage's HD-wallet AGGREGATE via CHIP-0002), receive, send, activity,
//     and per-origin window.chia consent, all over WalletConnect → Sage (wallet-wc.js).
//   - Shield — the active tab's verification verdict + per-resource proof ledger (dig-ledger.mjs).
//   - Control Panel — detect a local dig-node → manage it, else pitch installing one + a link to
//     the full-page onboarding landing (control.html) (dig-control.mjs).
//
// SoC (#41/#43): the extension is a PURE RPC CONSUMER. Client-side verify + decrypt stay; there
// is NO in-extension node/P2P/cache. The Control Panel CONTROLS a node or pitches one — it is not one.

import * as wc from './wallet-wc.js';
import { getApprovedOrigins } from './wallet-broker.mjs';
import { ACTIONS } from './messages.mjs';
import { groupLedger, inclusionProofDisplay, executionProofDisplay } from './dig-ledger.mjs';
import { controlPanelViewModel } from './dig-control.mjs';
import { TABS, resolveInitialTab, tabPanelId } from './tabs.mjs';
import {
  formatAssetBalance,
  validateSendForm,
  toBaseUnits,
  activityViewModel,
} from './wallet-view.mjs';
import { resolveViaStatus } from './resolve-status.mjs';
import { DIG_ASSET_ID } from './links.mjs';

// Full native DIG Browser releases — the Control Panel deep-links here for token-gated node
// management the extension can't drive under MV3 (no filesystem access to the control token).
const DIG_BROWSER_URL = 'https://github.com/DIG-Network/DIG_Browser/releases';
const TIBETSWAP_URL = 'https://v2.tibetswap.io/';

const $ = (id) => document.getElementById(id);

// One canonical verified label across popup / viewer / toolbar.
const VERIFIED_LABEL = 'Verified on Chia';
const VERIFIED_TOOLTIP = 'Merkle-proven against the on-chain root and decrypted on this device';

// ============================================================================
// Tab routing (Resolver · Wallet · Shield · Control Panel)
// ============================================================================
//
// tabs.mjs is the source of truth for the tab set/order/default + hash deep-link resolution; this
// is thin DOM glue over it. One panel is shown at a time via the [hidden] attribute; the active
// tab reflects aria-selected + a roving tabindex so the tablist is keyboard- and agent-drivable.

const TAB_BTN_ID = Object.freeze({
  resolver: 'tabResolver',
  wallet: 'tabWallet',
  shield: 'tabShield',
  control: 'tabControl',
});

function activateTab(tab) {
  for (const t of TABS) {
    const panel = $(tabPanelId(t));
    const btn = $(TAB_BTN_ID[t]);
    const active = t === tab;
    if (panel) panel.hidden = !active;
    if (btn) {
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
      btn.setAttribute('tabindex', active ? '0' : '-1');
    }
  }
  // Lazily refresh the shown tab's live data.
  if (tab === 'resolver') refreshResolveStatus();
  else if (tab === 'wallet') refreshWalletPanel();
  else if (tab === 'shield') refreshShieldPanel();
  else if (tab === 'control') refreshControlPanel();
}

function setupTabs() {
  for (const t of TABS) {
    const btn = $(TAB_BTN_ID[t]);
    if (!btn) continue;
    btn.addEventListener('click', () => activateTab(t));
    // Roving-tabindex arrow-key navigation across the tablist (WAI-ARIA tabs pattern).
    btn.addEventListener('keydown', (e) => {
      const idx = TABS.indexOf(t);
      let next = -1;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (idx + 1) % TABS.length;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (idx - 1 + TABS.length) % TABS.length;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = TABS.length - 1;
      if (next >= 0) {
        e.preventDefault();
        const nb = $(TAB_BTN_ID[TABS[next]]);
        if (nb) { nb.focus(); activateTab(TABS[next]); }
      }
    });
  }
}

// ============================================================================
// Resolver tab — §5.3 node resolution config
// ============================================================================
//
// The "Resolving via" line names which §5.3 tier serves the read path (custom > dig.local >
// localhost > rpc.dig.net), derived by resolve-status.mjs from the background probe. The
// custom-node override persists to `server.host` (the same key the background SW + options page
// read), so a user can point the extension at their own node — that value wins over the ladder.

async function refreshResolveStatus() {
  const el = $('resolveVia');
  if (!el) return;
  let status = { reachable: false, base: null };
  try {
    status = (await chrome.runtime.sendMessage({ action: ACTIONS.getDigNodeStatus })) || status;
  } catch { /* SW asleep / offline → honest hosted-fallback verdict below */ }
  let customHost = '';
  try {
    const o = await chrome.storage.local.get('server.host');
    customHost = o['server.host'] || '';
  } catch { /* ignore */ }
  const vm = resolveViaStatus(status, { customHost });
  el.textContent = vm.label;
  el.setAttribute('data-tier', vm.tier);
}

async function loadCustomNodeField() {
  const input = $('nodeHostInput');
  if (!input) return;
  try {
    const o = await chrome.storage.local.get('server.host');
    if (o['server.host']) input.value = o['server.host'];
  } catch { /* ignore */ }
}

async function saveCustomNode() {
  const input = $('nodeHostInput');
  const note = $('nodeHostNote');
  const host = (input && input.value ? input.value : '').trim();
  try { await chrome.storage.local.set({ 'server.host': host }); } catch { /* ignore */ }
  try { await chrome.runtime.sendMessage({ action: ACTIONS.updateServerConfig, host }); } catch { /* ignore */ }
  if (note) {
    note.textContent = host
      ? `Saved. The resolver will prefer ${host}.`
      : 'Cleared — using the default dig.local → localhost ladder.';
  }
  refreshResolveStatus();
}

function setupResolverNodeConfig() {
  const save = $('nodeHostSave');
  const input = $('nodeHostInput');
  if (save) save.addEventListener('click', saveCustomNode);
  if (input) input.addEventListener('keypress', (e) => { if (e.key === 'Enter') saveCustomNode(); });
  const openOptions = $('openOptionsLink');
  if (openOptions) {
    openOptions.addEventListener('click', (e) => {
      e.preventDefault();
      if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
      else chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
    });
  }
  loadCustomNodeField();
}

// ============================================================================
// Wallet tab — balances / receive / send / activity over WalletConnect → Sage
// ============================================================================
//
// The extension can't run an in-process wallet, so everything is brokered over WalletConnect to
// Sage, which manages the HD wallet and returns wallet-wide AGGREGATE balances (across all HD
// addresses) — so "full-HD aggregate" is satisfied by asking Sage rather than enumerating
// addresses. All number/validation logic lives in wallet-view.mjs (tested); this is thin glue.

async function refreshWalletPanel() {
  const state = $('walletState');
  const connected = $('walletConnected');
  const disconnected = $('walletDisconnected');
  if (!state) return;
  const conn = await wc.getConnection();
  if (conn && conn.connected) {
    state.textContent = 'Connected';
    state.classList.add('connected');
    if (disconnected) disconnected.hidden = true;
    if (connected) connected.hidden = false;
    const addr = $('walletAddress');
    if (addr) addr.textContent = conn.address || '—';
    refreshBalances();
  } else {
    state.textContent = 'Not connected';
    state.classList.remove('connected');
    if (connected) connected.hidden = true;
    if (disconnected) disconnected.hidden = false;
  }
}

async function refreshBalances() {
  const xch = $('walletXch');
  const dig = $('walletDig');
  if (xch) xch.textContent = '…';
  if (dig) dig.textContent = '…';
  // XCH: the wallet's aggregate confirmed balance.
  try {
    const xchBal = await wc.request('chip0002_getAssetBalance', { type: null, assetId: null });
    if (xch) xch.textContent = formatAssetBalance(xchBal, 'xch');
  } catch { if (xch) xch.textContent = '—'; }
  // $DIG CAT balance — query the DIG TAIL so the row shows a real number, or an honest em dash.
  try {
    const digBal = await wc.request('chip0002_getAssetBalance', { type: 'cat', assetId: DIG_ASSET_ID });
    if (dig) dig.textContent = formatAssetBalance(digBal, 'dig');
  } catch { if (dig) dig.textContent = '—'; }
}

// Wallet subviews (Receive / Send / Activity) — one shown at a time.
const WALLET_VIEWS = Object.freeze({ receive: 'walletReceive', send: 'walletSend', activity: 'walletActivity' });

function showWalletView(view) {
  for (const [v, id] of Object.entries(WALLET_VIEWS)) {
    const el = $(id);
    if (el) el.hidden = v !== view;
  }
  document.querySelectorAll('.wallet-subtab').forEach((b) => {
    b.setAttribute('aria-selected', b.getAttribute('data-view') === view ? 'true' : 'false');
  });
  if (view === 'activity') loadActivity();
}

function setupWalletSubtabs() {
  document.querySelectorAll('.wallet-subtab').forEach((b) => {
    b.addEventListener('click', () => showWalletView(b.getAttribute('data-view')));
  });
}

function setSendNote(msg, isError) {
  const n = $('sendNote');
  if (!n) return;
  n.textContent = msg || '';
  n.className = 'wallet-note' + (isError ? ' error' : '');
}

async function submitSend(e) {
  if (e) e.preventDefault();
  const asset = ($('sendAsset') && $('sendAsset').value) || 'xch';
  const address = ($('sendAddress') && $('sendAddress').value ? $('sendAddress').value : '').trim();
  const amount = ($('sendAmount') && $('sendAmount').value ? $('sendAmount').value : '').trim();
  const { ok, errors } = validateSendForm({ address, amount, asset });
  if (!ok) { setSendNote(errors.address || errors.amount, true); return; }
  let base;
  try { base = toBaseUnits(amount, asset); } catch (err) { setSendNote(err.message, true); return; }
  const assetId = asset === 'dig' ? DIG_ASSET_ID : null;
  setSendNote('Confirm the transaction in Sage…');
  try {
    await wc.request('chia_send', { assetId, amount: base, address, fee: 0 });
    setSendNote('Sent. It will appear in Activity once confirmed.');
    if ($('sendAddress')) $('sendAddress').value = '';
    if ($('sendAmount')) $('sendAmount').value = '';
  } catch (err) {
    setSendNote((err && err.message) || 'Send failed.', true);
  }
}

async function loadActivity() {
  const list = $('activityList');
  const note = $('activityNote');
  if (!list) return;
  if (note) note.textContent = 'Loading activity…';
  let raw = null;
  try {
    raw = await wc.request('chia_getTransactions', {});
  } catch {
    list.innerHTML = '';
    if (note) note.textContent = 'Activity is unavailable — reconnect Sage and try again.';
    return;
  }
  const vm = activityViewModel(raw, { digAssetId: DIG_ASSET_ID });
  list.innerHTML = '';
  if (!vm.length) { if (note) note.textContent = 'No activity yet.'; return; }
  if (note) note.textContent = '';
  for (const it of vm) {
    const li = document.createElement('li');
    li.className = 'activity-item ' + it.direction;
    const dir = document.createElement('span');
    dir.className = 'activity-dir';
    dir.textContent = it.direction === 'out' ? '↑' : '↓';
    const main = document.createElement('div');
    main.className = 'activity-main';
    const amt = document.createElement('span');
    amt.className = 'activity-amount';
    const ticker = it.asset === 'xch' ? 'XCH' : it.asset === 'dig' ? '$DIG' : 'CAT';
    amt.textContent = `${it.direction === 'out' ? '−' : '+'}${it.amountLabel} ${ticker}`;
    const time = document.createElement('span');
    time.className = 'activity-time';
    time.textContent = it.timeLabel || '';
    main.append(amt, time);
    li.append(dir, main);
    list.appendChild(li);
  }
}

async function startConnect() {
  const pairing = $('walletPairing');
  const uriInput = $('walletPairingUri');
  setWalletNote('Opening WalletConnect…');
  try {
    const { uri, approval } = await wc.connect();
    if (pairing && uriInput) {
      pairing.style.display = 'flex';
      uriInput.value = uri;
    }
    setWalletNote('Approve the connection in Sage to finish.');
    await approval();
    if (pairing) pairing.style.display = 'none';
    setWalletNote('Wallet connected.');
    await refreshWalletPanel();
  } catch (e) {
    setWalletNote((e && e.message) || 'Could not connect wallet.', true);
  }
}

async function doDisconnect() {
  try {
    await wc.disconnect();
    setWalletNote('Wallet disconnected.');
    await refreshWalletPanel();
  } catch (e) {
    setWalletNote((e && e.message) || 'Disconnect failed.', true);
  }
}

function setWalletNote(msg, isError) {
  const note = $('walletNote');
  if (!note) return;
  note.textContent = msg || '';
  note.className = 'wallet-note' + (isError ? ' error' : '');
}

function copyToClipboard(value) {
  if (value && navigator.clipboard) navigator.clipboard.writeText(value).catch(() => {});
}

function setupWalletActions() {
  const connectBtn = $('walletConnectBtn');
  const disconnectBtn = $('walletDisconnectBtn');
  const getDig = $('getDigLink');
  const pairCopy = $('walletPairingCopy');
  const addrCopy = $('walletAddressCopy');
  const sendForm = $('walletSend');

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
      if (uriInput && uriInput.value) { copyToClipboard(uriInput.value); uriInput.select(); }
    });
  }
  if (addrCopy) {
    addrCopy.addEventListener('click', () => {
      const addr = $('walletAddress');
      if (addr && addr.textContent && addr.textContent !== '—') copyToClipboard(addr.textContent);
    });
  }
  if (sendForm) sendForm.addEventListener('submit', submitSend);
}

// ============================================================================
// Shield tab — verification verdict + per-resource proof ledger (#134)
// ============================================================================
//
// Mirrors the native DIG Browser's dig://shields: the active tab's aggregate verification verdict,
// the capsule (storeId:rootHash) disclosure, and the per-resource inclusion-proof ledger grouped
// Verified (N) / Failed (M). Honest: execution proofs are never green-checked (the read path
// fetches inclusion only — see dig-ledger.mjs executionProofDisplay).

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
  try { resp = await chrome.runtime.sendMessage({ action: ACTIONS.getShieldLedger }); } catch { resp = null; }

  const v = resp && resp.verification;
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

  const capsule = resp && resp.capsule;
  if (capsule && capsule.storeId && capsuleWrap && capsuleVal) {
    capsuleWrap.style.display = 'flex';
    capsuleVal.textContent = `${capsule.storeId}:${capsule.rootHash || 'latest'}`;
  } else if (capsuleWrap) {
    capsuleWrap.style.display = 'none';
  }

  const entries = (resp && Array.isArray(resp.entries)) ? resp.entries : [];
  const group = (resp && resp.group) || groupLedger(entries);
  if (summary) {
    summary.innerHTML = '';
    if (!group.empty) {
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

// ============================================================================
// Control Panel tab — manage a local dig-node, or pitch installing one
// ============================================================================
//
// Mirrors the native DIG Browser's dig://control. Detects a local dig-node and renders either a
// MANAGE view (read-only node status; mutating control.* is token-gated and only the native DIG
// Browser can present the token), or an INSTALL pitch + a link to the full-page onboarding landing
// (control.html) for the full decentralized DIG Network. Reads keep working via rpc.dig.net either
// way — stated honestly. The manage/install decision is the tested pure view model (dig-control.mjs).

async function refreshControlPanel() {
  const panel = $('controlPanel');
  const body = $('controlBody');
  const controlDot = $('controlDot');
  if (!panel || !body) return;

  let view = null;
  try { view = await chrome.runtime.sendMessage({ action: ACTIONS.getControlStatus }); } catch { view = null; }
  if (!view) {
    view = { mode: 'install', localNode: false, controlEndpoint: null, status: null, authRequired: false };
  }

  const vm = controlPanelViewModel(view);
  panel.setAttribute('data-mode', vm.mode);
  if (controlDot) controlDot.setAttribute('data-node', vm.nodeOnline ? 'true' : 'false');
  body.innerHTML = '';

  if (vm.mode === 'manage') renderControlManage(body, vm);
  else renderControlInstall(body, vm);
}

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

  // The full-page onboarding landing (control.html) — the marketing surface for running a node
  // and joining the full decentralized DIG Network. Opening a full extension page is the §49
  // "no local node → full-page landing" behavior, offered as an explicit action.
  const full = document.createElement('button');
  full.className = 'control-cta secondary';
  full.setAttribute('data-testid', 'control-open-fullpage');
  full.textContent = 'See the full DIG Network →';
  full.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('control.html') });
    window.close();
  });
  body.appendChild(full);

  const fb = document.createElement('p');
  fb.setAttribute('data-testid', 'control-read-fallback');
  fb.textContent = vm.readFallbackLine;
  body.appendChild(fb);
}

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

// ============================================================================
// Per-origin connection requests (window.chia consent)
// ============================================================================

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
  try { await chrome.runtime.sendMessage({ action: ACTIONS.walletConsent, origin, approved }); } catch { /* ignore */ }
  await refreshConnReqs();
}

// ============================================================================
// Init
// ============================================================================

function init() {
  setupResolverNodeConfig();
  setupWalletActions();
  setupWalletSubtabs();
  setupTabs();

  // Open the tab named by the deep-link hash (#wallet / #shield / #control), else the resolver.
  activateTab(resolveInitialTab(location.hash));

  // Prime the Shield (verified) + Control (node present) status dots so their at-a-glance verdicts
  // show without first opening each tab — an agent-readable state.
  refreshShieldPanel();
  refreshControlPanel();
  refreshConnReqs();

  // Fulfil dapp window.chia requests over the relay while the popup is open.
  try { wc.listenForBrokeredRequests(); } catch { /* no WC bundle yet */ }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
