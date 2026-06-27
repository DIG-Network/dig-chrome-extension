// DIG settings (options) controller.
//
// Mirrors the native DIG Browser's chrome://settings DIG section within MV3 limits:
// local cache usage/clear, the dig-companion host (server.host) with a reachability
// check, the upstream DIG RPC endpoint, and the WalletConnect project id.

import { DIG_BROWSER_URL } from './links.mjs';

const $ = (id) => document.getElementById(id);

const DEFAULT_COMPANION = 'localhost:8080';
const DEFAULT_RPC = 'https://rpc.dig.net/';

function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

// ---- Cache ----
async function refreshCache() {
  try {
    const r = await chrome.runtime.sendMessage({ action: 'getCacheStats' });
    $('cacheStat').textContent = r
      ? `${r.entries} item${r.entries === 1 ? '' : 's'} · ~${fmtBytes(r.approxBytes)}`
      : '—';
  } catch {
    $('cacheStat').textContent = 'unavailable';
  }
}

async function clearCache() {
  const note = $('cacheNote');
  try {
    await chrome.runtime.sendMessage({ action: 'clearCache' });
    if (note) { note.textContent = 'Cache cleared.'; note.className = 'note ok'; }
    await refreshCache();
  } catch (e) {
    if (note) { note.textContent = 'Could not clear cache.'; note.className = 'note warn'; }
  }
}

// ---- Companion host (server.host) ----
async function loadCompanion() {
  const input = $('companionHost');
  try {
    const { 'server.host': host } = await chrome.storage.local.get('server.host');
    input.value = host || DEFAULT_COMPANION;
  } catch {
    input.value = DEFAULT_COMPANION;
  }
  checkCompanion();
}

async function saveCompanion() {
  const input = $('companionHost');
  const host = (input.value || '').trim() || DEFAULT_COMPANION;
  await chrome.storage.local.set({ 'server.host': host });
  // Keep the legacy split keys in sync (popup.js reads these too).
  const m = host.replace(/^https?:\/\//, '').match(/^([^:]+)(?::(\d+))?$/);
  if (m) {
    await chrome.storage.local.set({ 'server.url': m[1], 'server.port': m[2] ? parseInt(m[2], 10) : 80 });
  }
  checkCompanion();
}

async function checkCompanion() {
  const status = $('companionStatus');
  const host = ($('companionHost').value || '').trim() || DEFAULT_COMPANION;
  const url = /^https?:\/\//.test(host) ? host : `http://${host}`;
  status.textContent = 'Checking companion…';
  status.className = 'note';
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2000);
    await fetch(url + '/', { method: 'GET', mode: 'no-cors', signal: ctrl.signal });
    clearTimeout(t);
    status.textContent = `Companion reachable at ${host}.`;
    status.className = 'note ok';
  } catch {
    status.textContent =
      `Companion not running at ${host}. Start dig-companion, or leave this and the extension ` +
      `will use the hosted RPC endpoint below.`;
    status.className = 'note warn';
  }
}

// ---- Upstream RPC ----
async function loadRpc() {
  const input = $('rpcEndpoint');
  try {
    const { digRpcEndpoint } = await chrome.storage.local.get('digRpcEndpoint');
    input.value = digRpcEndpoint || DEFAULT_RPC;
  } catch {
    input.value = DEFAULT_RPC;
  }
}
async function saveRpc() {
  const raw = ($('rpcEndpoint').value || '').trim();
  const endpoint = raw ? (raw.endsWith('/') ? raw : raw + '/') : DEFAULT_RPC;
  await chrome.storage.local.set({ digRpcEndpoint: endpoint });
}

// ---- Wallet project id ----
async function loadProjectId() {
  try {
    const { 'wallet.projectId': pid } = await chrome.storage.local.get('wallet.projectId');
    $('projectId').value = pid || '';
  } catch { /* ignore */ }
}
async function saveProjectId() {
  const pid = ($('projectId').value || '').trim();
  await chrome.storage.local.set({ 'wallet.projectId': pid });
  const note = $('walletNote');
  if (note) {
    note.textContent = pid ? 'Project id saved.' : 'Enter a project id to enable wallet pairing.';
    note.className = 'note' + (pid ? ' ok' : '');
  }
}

function debounce(fn, ms) {
  let t;
  return () => { clearTimeout(t); t = setTimeout(fn, ms); };
}

function init() {
  refreshCache();
  loadCompanion();
  loadRpc();
  loadProjectId();

  $('clearCacheBtn').addEventListener('click', clearCache);
  $('companionHost').addEventListener('input', debounce(saveCompanion, 400));
  $('companionHost').addEventListener('blur', saveCompanion);
  $('companionDefaultBtn').addEventListener('click', () => {
    $('companionHost').value = DEFAULT_COMPANION;
    saveCompanion();
  });
  $('rpcEndpoint').addEventListener('input', debounce(saveRpc, 400));
  $('rpcEndpoint').addEventListener('blur', saveRpc);
  $('rpcDefaultBtn').addEventListener('click', () => { $('rpcEndpoint').value = DEFAULT_RPC; saveRpc(); });
  $('projectId').addEventListener('input', debounce(saveProjectId, 400));
  $('projectId').addEventListener('blur', saveProjectId);

  const browserLink = $('browserLink');
  if (browserLink) {
    browserLink.href = DIG_BROWSER_URL;
    browserLink.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: DIG_BROWSER_URL });
    });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
