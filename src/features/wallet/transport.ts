/**
 * Wallet transport — the page-resident WalletConnect → Sage backend the RTK Query wallet
 * endpoints call. Phase 0 keeps the EXISTING Sage-brokered model (the extension holds no keys);
 * Phase 1 adds a selectable local (offscreen) signer behind this same interface.
 *
 * WHY IN THE PAGE (not the SW): WalletConnect's SignClient needs IndexedDB + a long-lived relay
 * socket, which an MV3 service worker (evicted ~30 s idle) can't hold. So the live session lives
 * in the popup / `app.html` document, mirroring the proven `wallet-wc.js` pattern, and persists the
 * connection record to `chrome.storage.local` for the SW broker + other surfaces to read.
 *
 * The SignClient itself is a lazy dynamic import of the BUNDLED vendor ESM (extension-page CSP is
 * `script-src 'self'`, so it can't be a CDN). The transport is defined as an INTERFACE with an
 * injectable implementation so the wallet endpoints are unit-testable without a live relay.
 */

import { WALLET_METHODS } from '#shared/wallet-methods.mjs';
import { storageGet, storageSet } from '@/lib/messaging';

export const CHAIN = 'chia:mainnet';
export const CONNECTION_KEY = 'wallet.connection';
export const PROJECT_ID_KEY = 'wallet.projectId';

/** The shared wallet-connection record (read by the SW broker, popup, NTP). */
export interface Connection {
  connected: boolean;
  address?: string;
  network?: string;
  topic?: string;
}

/** A pairing handle: render `uri` (QR / copy), await `approval()` for the live session. */
export interface Pairing {
  uri: string;
  approval: () => Promise<{ topic: string; address: string }>;
}

/** The transport the wallet endpoints depend on (injected as the store's thunk extra arg). */
export interface WalletTransport {
  getConnection(): Promise<Connection>;
  isConnected(): Promise<boolean>;
  connect(): Promise<Pairing>;
  disconnect(): Promise<void>;
  /** Broker one wallet RPC; the result is untyped at the wire boundary (callers narrow it). */
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

/** Extract a chia address from a WC session's accounts (`chia:mainnet:<address>`). Pure. */
export function sessionAddress(session: unknown): string {
  try {
    const accts =
      (session as { namespaces?: { chia?: { accounts?: string[] } } })?.namespaces?.chia?.accounts ?? [];
    const first = accts[0] || '';
    const parts = first.split(':');
    return parts[parts.length - 1] || '';
  } catch {
    return '';
  }
}

/** Read the shared connection record from `chrome.storage.local`. */
export async function readConnection(): Promise<Connection> {
  const out = await storageGet<{ [CONNECTION_KEY]: Connection }>(CONNECTION_KEY);
  return out[CONNECTION_KEY] || { connected: false };
}

/** Persist the shared connection record. */
export async function writeConnection(conn: Connection): Promise<void> {
  await storageSet({ [CONNECTION_KEY]: conn });
}

/* c8 ignore start — live WalletConnect I/O (dynamic import, relay socket) is exercised e2e with a
   real wallet, not in the unit harness; the pure parsing/storage helpers above are unit-tested. */

interface SignClientLike {
  connect(opts: unknown): Promise<{ uri?: string; approval: () => Promise<unknown> }>;
  disconnect(opts: unknown): Promise<void>;
  request<T>(opts: unknown): Promise<T>;
}

let _client: SignClientLike | null = null;

async function getProjectId(): Promise<string> {
  const out = await storageGet<{ [PROJECT_ID_KEY]: string }>(PROJECT_ID_KEY);
  return out[PROJECT_ID_KEY] || '';
}

async function loadClient(): Promise<SignClientLike> {
  if (_client) return _client;
  const mod = (await import(
    /* @vite-ignore */ chrome.runtime.getURL('vendor/walletconnect-sign-client.js')
  )) as { default?: unknown; SignClient?: unknown };
  const SignClient = (mod.default || mod.SignClient || mod) as {
    init(opts: unknown): Promise<SignClientLike>;
  };
  const projectId = await getProjectId();
  if (!projectId) throw new Error('Set a WalletConnect project id in DIG settings to connect a wallet.');
  _client = await SignClient.init({
    logger: 'error',
    projectId,
    metadata: {
      name: 'DIG Network Extension',
      description: 'Resolve chia:// content and connect your Chia wallet.',
      url: 'https://dig.net',
      icons: ['https://dig.net/favicon.png'],
    },
  });
  return _client;
}

/** The production WalletConnect → Sage transport (page-resident). */
export const wcTransport: WalletTransport = {
  getConnection: readConnection,
  async isConnected() {
    return (await readConnection()).connected === true;
  },
  async connect() {
    const client = await loadClient();
    const { uri, approval } = await client.connect({
      optionalNamespaces: { chia: { methods: WALLET_METHODS, chains: [CHAIN], events: [] } },
    });
    return {
      uri: uri || '',
      approval: async () => {
        const session = await approval();
        const topic = (session as { topic: string }).topic;
        const address = sessionAddress(session);
        await writeConnection({ connected: true, topic, address, network: 'mainnet' });
        return { topic, address };
      },
    };
  },
  async disconnect() {
    const conn = await readConnection();
    try {
      if (_client && conn.topic) {
        await _client.disconnect({ topic: conn.topic, reason: { code: 6000, message: 'bye' } });
      }
    } catch {
      /* best effort */
    }
    await writeConnection({ connected: false });
  },
  async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const client = await loadClient();
    const conn = await readConnection();
    if (!conn.topic) throw new Error('No wallet session');
    return client.request<unknown>({ topic: conn.topic, chainId: CHAIN, request: { method, params: params || {} } });
  },
};
/* c8 ignore stop */
