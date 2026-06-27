// Popup wallet panel + verified line + per-origin consent UI + DIG settings link.
//
// Loaded as a module alongside popup.js (which keeps the existing RPC/host controls).
// This module owns the parity features added to reach the native DIG Browser experience:
//   - Wallet panel: balance (XCH + DIG) + connect/disconnect (WalletConnect → Sage) + Get DIG.
//   - Verified badge line: reflects the active tab's chia:// Merkle-verification state.
//   - Connection requests: approve/deny dapps' window.chia.connect() per origin.
//   - DIG settings link: opens the options page (cache + companion).

import * as wc from './wallet-wc.js';
import { getApprovedOrigins } from './wallet-broker.mjs';

const TIBETSWAP_URL = 'https://v2.tibetswap.io/';
const $ = (id) => document.getElementById(id);

// ---- Verified badge line ----
async function refreshVerifyLine() {
  const line = $('verifyLine');
  const dot = $('verifyDot');
  const text = $('verifyText');
  if (!line) return;
  try {
    const resp = await chrome.runtime.sendMessage({ action: 'getVerification' });
    const v = resp && resp.verification;
    if (v && v.state === 'verified') {
      line.style.display = 'flex';
      line.className = 'verify-line verified';
      text.textContent = 'Verified — proven against the on-chain root';
    } else if (v && v.state === 'failed') {
      line.style.display = 'flex';
      line.className = 'verify-line failed';
      text.textContent = 'Verification failed — do not trust this content';
    } else {
      line.style.display = 'none';
    }
  } catch {
    line.style.display = 'none';
  }
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
  // DIG CAT balance — assetId left to the wallet's configured DIG asset; shown as — if unknown.
  if (dig) dig.textContent = '—';
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

  refreshVerifyLine();
  refreshWalletPanel();
  refreshConnReqs();

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
