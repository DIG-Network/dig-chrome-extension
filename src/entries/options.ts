/**
 * DIG settings (options.html) — the ONE settings home. The extension is a pure RPC consumer (it
 * does NOT cache resolved content — caching is a dig-node job), so this page only configures: the
 * dig-node host (`server.host`) with a reachability check, the upstream DIG RPC endpoint, and the
 * WalletConnect project id. Pure DOM glue, built by Vite as a standalone extension page under
 * `src/entries/`; the shared parser/resolver come from `#shared/*` so the background read path and
 * these keys can never disagree on the default port.
 */
import { DIG_BROWSER_URL } from '#shared/links.mjs';
import { DEFAULT_DIG_NODE_HOST, parseServerHost, resolveDigNode } from '#shared/server-config.mjs';
import { digNodeInstallPrompt } from '#shared/dig-node-status.mjs';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T | null =>
  document.getElementById(id) as T | null;

const DEFAULT_RPC = 'https://rpc.dig.net/';

// ---- dig-node host (server.host) ----
async function loadCompanion(): Promise<void> {
  const input = $<HTMLInputElement>('companionHost');
  if (!input) return;
  try {
    const { 'server.host': host } = await chrome.storage.local.get('server.host');
    input.value = (host as string) || DEFAULT_DIG_NODE_HOST;
  } catch {
    input.value = DEFAULT_DIG_NODE_HOST;
  }
  void checkCompanion();
}

async function saveCompanion(): Promise<void> {
  const input = $<HTMLInputElement>('companionHost');
  if (!input) return;
  const host = (input.value || '').trim() || DEFAULT_DIG_NODE_HOST;
  await chrome.storage.local.set({ 'server.host': host });
  // Keep the legacy split keys in sync via the SHARED parser (so the background read path and these
  // keys can never disagree on the default port — 8080, the dig-node port).
  const { url, port } = parseServerHost(host);
  await chrome.storage.local.set({ 'server.url': url, 'server.port': port });
  void checkCompanion();
}

async function checkCompanion(): Promise<void> {
  const status = $('companionStatus');
  const input = $<HTMLInputElement>('companionHost');
  if (!status || !input) return;
  const host = (input.value || '').trim() || DEFAULT_DIG_NODE_HOST;
  status.textContent = 'Checking dig-node…';
  status.className = 'note';
  // Use the SHARED resolver so this reflects the same try-list the background read path uses: an
  // explicitly-configured custom host wins ENTIRELY (§5.3); otherwise dig.local first (branded,
  // port 80), then localhost:<port>. Reports the reachable address.
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
async function loadRpc(): Promise<void> {
  const input = $<HTMLInputElement>('rpcEndpoint');
  if (!input) return;
  try {
    const { digRpcEndpoint } = await chrome.storage.local.get('digRpcEndpoint');
    input.value = (digRpcEndpoint as string) || DEFAULT_RPC;
  } catch {
    input.value = DEFAULT_RPC;
  }
}

async function saveRpc(): Promise<void> {
  const input = $<HTMLInputElement>('rpcEndpoint');
  if (!input) return;
  const raw = (input.value || '').trim();
  const endpoint = raw ? (raw.endsWith('/') ? raw : raw + '/') : DEFAULT_RPC;
  await chrome.storage.local.set({ digRpcEndpoint: endpoint });
}

// ---- Wallet project id ----
async function loadProjectId(): Promise<void> {
  const input = $<HTMLInputElement>('projectId');
  if (!input) return;
  try {
    const { 'wallet.projectId': pid } = await chrome.storage.local.get('wallet.projectId');
    input.value = (pid as string) || '';
  } catch {
    /* ignore */
  }
}

async function saveProjectId(): Promise<void> {
  const input = $<HTMLInputElement>('projectId');
  if (!input) return;
  const pid = (input.value || '').trim();
  await chrome.storage.local.set({ 'wallet.projectId': pid });
  const note = $('walletNote');
  if (note) {
    note.textContent = pid ? 'Project id saved.' : 'Enter a project id to enable wallet pairing.';
    note.className = 'note' + (pid ? ' ok' : '');
  }
}

function debounce(fn: () => void, ms: number): () => void {
  let t: ReturnType<typeof setTimeout>;
  return () => {
    clearTimeout(t);
    t = setTimeout(fn, ms);
  };
}

function init(): void {
  void loadCompanion();
  void loadRpc();
  void loadProjectId();

  const companionHost = $<HTMLInputElement>('companionHost');
  companionHost?.addEventListener('input', debounce(() => void saveCompanion(), 400));
  companionHost?.addEventListener('blur', () => void saveCompanion());
  $('companionDefaultBtn')?.addEventListener('click', () => {
    if (companionHost) companionHost.value = DEFAULT_DIG_NODE_HOST;
    void saveCompanion();
  });

  const rpcEndpoint = $<HTMLInputElement>('rpcEndpoint');
  rpcEndpoint?.addEventListener('input', debounce(() => void saveRpc(), 400));
  rpcEndpoint?.addEventListener('blur', () => void saveRpc());
  $('rpcDefaultBtn')?.addEventListener('click', () => {
    if (rpcEndpoint) rpcEndpoint.value = DEFAULT_RPC;
    void saveRpc();
  });

  const projectId = $<HTMLInputElement>('projectId');
  projectId?.addEventListener('input', debounce(() => void saveProjectId(), 400));
  projectId?.addEventListener('blur', () => void saveProjectId());

  const browserLink = $<HTMLAnchorElement>('browserLink');
  if (browserLink) {
    browserLink.href = DIG_BROWSER_URL;
    browserLink.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs?.create({ url: DIG_BROWSER_URL });
    });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
