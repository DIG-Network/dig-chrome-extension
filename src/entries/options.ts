/**
 * DIG settings (options.html) — the ONE settings home. The extension is a pure RPC consumer (it
 * does NOT cache resolved content — caching is a dig-node job), so this page only configures: the
 * dig-node host (`server.host`) with a reachability check and the upstream DIG RPC endpoint. Pure
 * DOM glue, built by Vite as a standalone extension page under `src/entries/`; the shared
 * parser/resolver come from `#shared/*` so the background read path and these keys can never
 * disagree on the default port.
 */
import { DIG_BROWSER_URL } from '@/lib/links';
import { DEFAULT_DIG_NODE_HOST, parseServerHost, resolveDigNode } from '@/lib/server-config';
import { digNodeInstallPrompt } from '@/lib/dig-node-status';
import { readWalletSettings, updateWalletSettings, type WalletSettings } from '@/features/wallet/custody/settings';
import { DEFAULT_THEME_MODE, isThemeMode, resolveEffectiveTheme, type ThemeMode } from '@/lib/theme';

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
  // keys can never disagree on the default port — 9778, the canonical dig-node control port).
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

// ---- Appearance / theme (#211) ----
const DARK_QUERY = '(prefers-color-scheme: dark)';

/** Paint the RESOLVED theme onto this settings page's `documentElement` (the same `data-dig-theme`
 *  attribute `theme.css` / this page's dark palette key off), mirroring `useAppliedTheme` so the
 *  settings page matches the wallet. `system` follows the OS signal. */
function applyOptionsTheme(mode: ThemeMode): void {
  const mql = typeof window.matchMedia === 'function' ? window.matchMedia(DARK_QUERY) : null;
  document.documentElement.dataset.digTheme = resolveEffectiveTheme(mode, mql?.matches ?? false);
}

async function loadTheme(): Promise<void> {
  const select = $<HTMLSelectElement>('themeSelect');
  if (!select) return;
  const settings = await readWalletSettings().catch((): WalletSettings => ({}));
  // No stored preference → the #211 default (light), never the OS-following `system`.
  const mode: ThemeMode = isThemeMode(settings.theme) ? settings.theme : DEFAULT_THEME_MODE;
  select.value = mode;
  applyOptionsTheme(mode);

  // While on `system`, track live OS changes so the settings page repaints without a reload
  // (matches the wallet's `useAppliedTheme`). Registered once; only acts when the current pick is
  // `system`.
  window.matchMedia?.(DARK_QUERY).addEventListener('change', () => {
    if (($<HTMLSelectElement>('themeSelect')?.value ?? '') === 'system') applyOptionsTheme('system');
  });
}

async function saveTheme(): Promise<void> {
  const select = $<HTMLSelectElement>('themeSelect');
  if (!select) return;
  const mode: ThemeMode = isThemeMode(select.value) ? select.value : DEFAULT_THEME_MODE;
  applyOptionsTheme(mode);
  // Read-modify-write the shared `wallet.settings` blob so unrelated prefs (locale, network, …)
  // survive; the popup + full-screen wallet pick this up live via the storage→store bridge.
  await updateWalletSettings({ theme: mode });
}

function debounce(fn: () => void, ms: number): () => void {
  let t: ReturnType<typeof setTimeout>;
  return () => {
    clearTimeout(t);
    t = setTimeout(fn, ms);
  };
}

function init(): void {
  void loadTheme();
  void loadCompanion();
  void loadRpc();

  $<HTMLSelectElement>('themeSelect')?.addEventListener('change', () => void saveTheme());

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
