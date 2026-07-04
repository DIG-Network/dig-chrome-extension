// DIG settings (options) controller — the ONE settings home.
//
// The extension is a pure RPC consumer — it does NOT cache resolved content (caching is a
// dig-node job; see #43 / #41 SoC audit). This page configures: the dig-node host
// (server.host) with a reachability check, the upstream DIG RPC endpoint, and the
// WalletConnect project id. (The popup is the product surface; all config controls live here.)

import { DIG_BROWSER_URL } from './links.mjs';
import { DEFAULT_DIG_NODE_HOST, parseServerHost, resolveDigNode } from './server-config.mjs';
import { digNodeInstallPrompt } from './dig-node-status.mjs';

const $ = (id) => document.getElementById(id);

const DEFAULT_RPC = 'https://rpc.dig.net/';

// ---- dig-node host (server.host) ----
async function loadCompanion() {
  const input = $('companionHost');
  try {
    const { 'server.host': host } = await chrome.storage.local.get('server.host');
    input.value = host || DEFAULT_DIG_NODE_HOST;
  } catch {
    input.value = DEFAULT_DIG_NODE_HOST;
  }
  checkCompanion();
}

async function saveCompanion() {
  const input = $('companionHost');
  const host = (input.value || '').trim() || DEFAULT_DIG_NODE_HOST;
  await chrome.storage.local.set({ 'server.host': host });
  // Keep the legacy split keys in sync via the SHARED parser (so the background read path
  // and these keys can never disagree on the default port — 8080, the dig-node port).
  const { url, port } = parseServerHost(host);
  await chrome.storage.local.set({ 'server.url': url, 'server.port': port });
  checkCompanion();
}

async function checkCompanion() {
  const status = $('companionStatus');
  const host = ($('companionHost').value || '').trim() || DEFAULT_DIG_NODE_HOST;
  status.textContent = 'Checking dig-node…';
  status.className = 'note';
  // Use the SHARED resolver so this reflects the same try-list the background read path uses:
  // an explicitly-configured custom host wins ENTIRELY (§5.3); otherwise dig.local first
  // (branded, port 80), then localhost:<port>. Reports the reachable address.
  const base = await resolveDigNode(host, { timeoutMs: 2000 }).catch(() => null);
  if (base) {
    status.textContent = `dig-node reachable at ${base}.`;
    status.className = 'note ok';
    return;
  }
  const prompt = digNodeInstallPrompt();
  status.textContent =
    `dig-node not found. ${prompt.installLabel} (${prompt.installUrl}), or leave this — the ` +
    `extension will use the hosted RPC endpoint below.`;
  status.className = 'note warn';
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
  loadCompanion();
  loadRpc();
  loadProjectId();

  $('companionHost').addEventListener('input', debounce(saveCompanion, 400));
  $('companionHost').addEventListener('blur', saveCompanion);
  $('companionDefaultBtn').addEventListener('click', () => {
    $('companionHost').value = DEFAULT_DIG_NODE_HOST;
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
