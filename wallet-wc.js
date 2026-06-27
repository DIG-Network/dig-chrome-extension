// WalletConnect → Sage transport, popup edition.
//
// WHY THIS RUNS IN THE POPUP (not the service worker): WalletConnect SignClient needs
// IndexedDB and a long-lived relay WebSocket. An MV3 service worker is evicted after ~30s
// idle and loses both, so the live session must live in a persistent extension page. The
// popup is that page: while it's open it holds the SignClient + socket, persists the
// session record to chrome.storage.local (so the SW broker / NTP can read connection
// state), and fulfils `walletProxyToPopup` requests the SW forwards from dapps' window.chia.
//
// This mirrors the proven hub.dig.net WalletConnect pattern (apps/web/lib/walletconnect.js):
// optionalNamespaces only (Sage rejects requiredNamespaces), the CHIP-0002 method set, and
// request via client.request({ topic, chainId, request: { method, params } }).
//
// WC CLIENT LOADING: extension-page CSP is `script-src 'self'` — remote scripts are blocked,
// so SignClient must be BUNDLED into the extension at ./vendor/walletconnect-sign-client.js
// (an ESM build). When that file is absent (current pre-release state) the panel still works
// for connection-request consent + state; pairing reports an actionable note. Dropping the
// bundled ESM in enables live pairing with no other change here.

import { WALLET_METHODS } from './wallet-methods.mjs';

export const CHAIN = 'chia:mainnet';
export const CONNECTION_KEY = 'wallet.connection';

// WalletConnect project id. Override via chrome.storage.local 'wallet.projectId' (set in
// the options page) so deployers can use their own Reown/WalletConnect project.
const DEFAULT_PROJECT_ID = '';

let _client = null;
let _clientPromise = null;

/** Dynamically import the BUNDLED SignClient ESM. Throws a clear error if not bundled. */
async function loadSignClient() {
  try {
    const mod = await import(chrome.runtime.getURL('vendor/walletconnect-sign-client.js'));
    return mod.default || mod.SignClient || mod;
  } catch (e) {
    throw new Error(
      'WalletConnect client not bundled. Add vendor/walletconnect-sign-client.js (ESM build) ' +
      'to enable live Sage pairing. (Extension-page CSP blocks loading it from a CDN.)'
    );
  }
}

async function getProjectId() {
  try {
    const { 'wallet.projectId': pid } = await chrome.storage.local.get('wallet.projectId');
    return pid || DEFAULT_PROJECT_ID;
  } catch {
    return DEFAULT_PROJECT_ID;
  }
}

/** Initialise (once) the SignClient. */
async function getClient() {
  if (_client) return _client;
  if (!_clientPromise) {
    _clientPromise = (async () => {
      const SignClient = await loadSignClient();
      const projectId = await getProjectId();
      if (!projectId) {
        throw new Error('Set a WalletConnect project id in DIG settings to connect a wallet.');
      }
      const c = await SignClient.init({
        logger: 'error',
        projectId,
        metadata: {
          name: 'DIG Network Extension',
          description: 'Resolve chia:// content and connect your Chia wallet.',
          url: 'https://dig.net',
          icons: ['https://dig.net/favicon.png'],
        },
      });
      _client = c;
      _clientPromise = null;
      return c;
    })().catch((e) => { _clientPromise = null; throw e; });
  }
  return _clientPromise;
}

/** Persist the shared connection record (read by the SW broker, popup, NTP). */
async function persistConnection(conn) {
  await chrome.storage.local.set({ [CONNECTION_KEY]: conn });
}

/** Read the shared connection record. */
export async function getConnection() {
  const out = await chrome.storage.local.get(CONNECTION_KEY);
  return out[CONNECTION_KEY] || { connected: false };
}

/**
 * Begin pairing. Returns { uri, approval } — render `uri` as a copy-link / QR; await
 * `approval()` for the session, then call onConnected().
 */
export async function connect() {
  const c = await getClient();
  const { uri, approval } = await c.connect({
    optionalNamespaces: { chia: { methods: WALLET_METHODS, chains: [CHAIN], events: [] } },
  });
  const finish = async () => {
    const session = await approval();
    const topic = session.topic;
    const address = sessionAddress(session);
    await persistConnection({ connected: true, topic, address, network: 'mainnet' });
    return { topic, address };
  };
  return { uri, approval: finish };
}

/** Extract a chia address from a session's accounts (chia:mainnet:<address>). */
function sessionAddress(session) {
  try {
    const accts = session.namespaces.chia.accounts || [];
    const first = accts[0] || '';
    const parts = first.split(':');
    return parts[parts.length - 1] || '';
  } catch {
    return '';
  }
}

/** Disconnect the active session and clear persisted state. */
export async function disconnect() {
  const conn = await getConnection();
  try {
    if (_client && conn.topic) {
      await _client.disconnect({ topic: conn.topic, reason: { code: 6000, message: 'bye' } });
    }
  } catch { /* best effort */ }
  await persistConnection({ connected: false });
}

/** One wallet request over the relay to Sage. */
export async function request(method, params) {
  const c = await getClient();
  const conn = await getConnection();
  if (!conn.topic) throw new Error('No wallet session');
  return c.request({ topic: conn.topic, chainId: CHAIN, request: { method, params: params || {} } });
}

/**
 * Wire the popup to fulfil `walletProxyToPopup` requests the SW forwards from dapps.
 * While the popup is open, dapp window.chia calls resolve through here over the relay.
 */
export function listenForBrokeredRequests() {
  if (!chrome.runtime || !chrome.runtime.onMessage) return;
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.action !== 'walletProxyToPopup') return false;
    (async () => {
      try {
        const data = await request(message.method, message.params);
        sendResponse({ data });
      } catch (e) {
        sendResponse({ error: (e && e.message) || 'wallet request failed' });
      }
    })();
    return true; // async
  });
}
