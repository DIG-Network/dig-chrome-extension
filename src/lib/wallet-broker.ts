/**
 * Wallet broker — per-origin consent + CHIP-0002 method routing for the injected
 * `window.chia` provider, backed by WalletConnect → Sage.
 *
 * The native DIG Browser runs an in-process wallet gated by the unspoofable committed
 * origin. An MV3 extension can't run a wallet, so it brokers requests over WalletConnect
 * to Sage (the proven hub path). This module is the transport-agnostic core: it tracks
 * which origins the user has approved, validates/normalises methods, and decides what
 * envelope to return. The actual WC relay calls are injected as a `transport` so the
 * core is unit-testable without a live relay.
 *
 * Envelope shape (matches dig-provider.js expectations):
 *   { status: <http-like u16>, body: { data } | { error } }
 *   - 200  success            → body.data is the method result
 *   - 202  pending approval   → provider polls connect() until 200/4xx
 *   - 4xx  rejected / error   → body.error
 *
 * Storage keys (chrome.storage.local):
 *   - 'wallet.connection'      { connected, address, network, topic }  (shared w/ popup + NTP)
 *   - 'wallet.origins'         { [origin]: { approved: true, ts } }     (per-origin consent)
 */

import { normalizeMethod, isSupportedMethod } from './wallet-methods';

export const ORIGINS_KEY = 'wallet.origins';
export const CONNECTION_KEY = 'wallet.connection';

/** A `chrome.storage.local`-like async key/value store (injectable for tests). */
export interface StorageLike {
  get(keys: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}
/** One per-origin consent record. */
export interface OriginRecord {
  approved: boolean;
  ts: number;
}
/** The per-origin consent map keyed by page origin. */
export type OriginsMap = Record<string, OriginRecord>;
/** The shared wallet-connection record (persisted for popup + NTP). */
export interface ConnectionRecord {
  connected: boolean;
  address?: string;
  network?: string;
  topic?: string;
}
/** The HTTP-like envelope every broker call returns. */
export interface BrokerEnvelope {
  status: number;
  body: { data?: unknown; error?: string };
}
/** The injectable WalletConnect → Sage transport. */
export interface WalletTransport {
  isConnected(): Promise<boolean>;
  request(args: { method: string; params: unknown }): Promise<unknown>;
}
/** Dependencies injected into {@link brokerRequest}. */
export interface BrokerDeps {
  storage: StorageLike;
  transport: WalletTransport;
  requestConsent?: (origin: string) => Promise<boolean>;
}

/** Read the per-origin consent map. `storage` is a chrome.storage.local-like object. */
export async function getApprovedOrigins(storage: StorageLike): Promise<OriginsMap> {
  const out = await storage.get(ORIGINS_KEY);
  return (out[ORIGINS_KEY] as OriginsMap) || {};
}

/** True if `origin` has been approved by the user for wallet access. */
export async function isOriginApproved(storage: StorageLike, origin: string): Promise<boolean> {
  const map = await getApprovedOrigins(storage);
  return !!(map[origin] && map[origin].approved);
}

/** Record (or clear) approval for `origin`. */
export async function setOriginApproval(
  storage: StorageLike,
  origin: string,
  approved: boolean,
): Promise<OriginsMap> {
  const map = await getApprovedOrigins(storage);
  if (approved) {
    map[origin] = { approved: true, ts: Date.now() };
  } else {
    delete map[origin];
  }
  await storage.set({ [ORIGINS_KEY]: map });
  return map;
}

/** Read the shared wallet-connection record (used by popup + NTP). */
export async function getConnection(storage: StorageLike): Promise<ConnectionRecord> {
  const out = await storage.get(CONNECTION_KEY);
  return (out[CONNECTION_KEY] as ConnectionRecord) || { connected: false };
}

/** Build a success / error / pending envelope. */
export function ok(data: unknown): BrokerEnvelope { return { status: 200, body: { data } }; }
export function pending(): BrokerEnvelope { return { status: 202, body: {} }; }
export function err(status: number, message: string): BrokerEnvelope { return { status: status || 400, body: { error: message } }; }

/**
 * Broker one wallet RPC for `origin`.
 *
 * @param {object} deps
 * @param {object} deps.storage  chrome.storage.local-like { get, set }
 * @param {object} deps.transport WC transport: { isConnected(): Promise<bool>,
 *                 request({method, params}): Promise<any> }
 * @param {function} [deps.requestConsent] async (origin) => boolean — prompt the user to
 *                 approve this origin (e.g. open the popup). If omitted, a non-approved
 *                 origin yields a 202 (pending) so the provider can poll while the user
 *                 approves out-of-band in the popup.
 * @param {string} method  raw method name (bare / namespaced)
 * @param {object} params
 * @param {string} origin  committed page origin (from the content-script bridge)
 * @returns {Promise<{status:number, body:object}>}
 */
export async function brokerRequest(
  deps: BrokerDeps,
  method: string,
  params: unknown,
  origin: string,
): Promise<BrokerEnvelope> {
  const { storage, transport, requestConsent } = deps;
  if (!origin) return err(400, 'Missing origin');

  const norm = normalizeMethod(method);

  // connect: gate on per-origin consent, then ensure a live WC session.
  if (norm === 'chip0002_connect') {
    let approved = await isOriginApproved(storage, origin);
    if (!approved) {
      if (typeof requestConsent === 'function') {
        approved = await requestConsent(origin);
        if (approved) await setOriginApproval(storage, origin, true);
      }
      if (!approved) return pending(); // provider polls; user approves in the popup
    }
    // Origin approved — make sure a wallet session exists.
    const live = await transport.isConnected();
    if (!live) {
      // No Sage session yet; the user must pair the wallet in the popup first.
      return pending();
    }
    const conn = await getConnection(storage);
    return ok({ address: conn.address, network: conn.network || 'mainnet' });
  }

  // All other methods require an already-approved origin.
  if (!(await isOriginApproved(storage, origin))) {
    return err(401, 'Origin not connected — call window.chia.connect() first');
  }
  if (!isSupportedMethod(norm)) {
    return err(404, `Unsupported method: ${norm}`);
  }
  if (!(await transport.isConnected())) {
    return err(503, 'Wallet not connected — pair Sage in the extension popup');
  }

  try {
    const data = await transport.request({ method: norm, params: params || {} });
    return ok(data);
  } catch (e) {
    // Sage rejection / relay error.
    const msg = (e instanceof Error && e.message) || 'Wallet request failed';
    return err(502, msg);
  }
}
