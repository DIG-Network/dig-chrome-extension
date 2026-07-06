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
/**
 * One per-origin consent record. Evolved (#67 P0-4) from a plain approval boolean into a capability
 * record (EIP-2255-shaped, Chia-mapped) — but BACKWARDS COMPATIBLE: the extra fields are optional, so
 * a legacy `{ approved, ts }` record still reads as a connected site (no migration needed).
 */
export interface OriginRecord {
  approved: boolean;
  /** Grant timestamp (kept as `ts` for backwards compat; surfaced as `grantedAt`). */
  ts: number;
  /** Addresses this origin has been shown (the EIP-2255 `restrictReturnedAddresses` caveat value). */
  addresses?: string[];
  /** Methods this origin has been granted / has invoked. */
  methods?: string[];
  /** Last time a request from this origin was served (null until first use). */
  lastUsed?: number;
}

/** A normalized, UI/agent-facing view of one connected site's permission (#67 P0-4). */
export interface OriginPermission {
  origin: string;
  approved: boolean;
  addresses: string[];
  methods: string[];
  grantedAt: number;
  lastUsed: number | null;
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

// ── Granular revocable permissions + Connected sites (#67 P0-4, EIP-2255-shaped, Chia-mapped) ──────

/** Merge two optional string arrays into a deduped, empties-dropped array (order-preserving). */
function mergeUnique(a?: readonly string[], b?: readonly string[]): string[] {
  const out: string[] = [];
  for (const s of [...(a || []), ...(b || [])]) {
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * Normalize an {@link OriginRecord} into the UI/agent-facing {@link OriginPermission}, or `null` when
 * the record is absent/unapproved. Backwards compatible: a legacy `{ approved, ts }` record yields an
 * empty `addresses`/`methods` and a `null` `lastUsed`.
 */
export function toPermission(origin: string, rec: OriginRecord | null | undefined): OriginPermission | null {
  if (!rec || !rec.approved) return null;
  return {
    origin,
    approved: true,
    addresses: Array.isArray(rec.addresses) ? rec.addresses : [],
    methods: Array.isArray(rec.methods) ? rec.methods : [],
    grantedAt: typeof rec.ts === 'number' ? rec.ts : 0,
    lastUsed: typeof rec.lastUsed === 'number' ? rec.lastUsed : null,
  };
}

/** List every connected site as a permission, most-recently-active first (for the Connected-sites UI). */
export async function listPermissions(storage: StorageLike): Promise<OriginPermission[]> {
  const map = await getApprovedOrigins(storage);
  return Object.entries(map)
    .map(([origin, rec]) => toPermission(origin, rec))
    .filter((p): p is OriginPermission => p !== null)
    .sort((a, b) => (b.lastUsed ?? b.grantedAt) - (a.lastUsed ?? a.grantedAt));
}

/**
 * Grant (or upgrade) an origin's capability: mark approved, merge in any addresses/methods, and keep
 * a STABLE `grantedAt` across re-grants. This is the richer counterpart to {@link setOriginApproval}
 * used when the connect address / invoked methods are known.
 */
export async function grantOrigin(
  storage: StorageLike,
  origin: string,
  opts: { addresses?: string[]; methods?: string[] } = {},
): Promise<OriginsMap> {
  const map = await getApprovedOrigins(storage);
  const prev = map[origin];
  map[origin] = {
    approved: true,
    ts: prev && typeof prev.ts === 'number' ? prev.ts : Date.now(),
    addresses: mergeUnique(prev?.addresses, opts.addresses),
    methods: mergeUnique(prev?.methods, opts.methods),
    lastUsed: prev?.lastUsed,
  };
  await storage.set({ [ORIGINS_KEY]: map });
  return map;
}

/**
 * Record that an approved origin was used: bump `lastUsed` and merge in the invoked method / shown
 * address. A no-op for an origin that is not (or no longer) approved, so a revoked site is never
 * silently resurrected. Best-effort — callers fire-and-forget.
 */
export async function noteOriginUsage(
  storage: StorageLike,
  origin: string,
  opts: { method?: string; address?: string } = {},
): Promise<void> {
  const map = await getApprovedOrigins(storage);
  const rec = map[origin];
  if (!rec || !rec.approved) return;
  rec.lastUsed = Date.now();
  if (opts.method) rec.methods = mergeUnique(rec.methods, [opts.method]);
  if (opts.address) rec.addresses = mergeUnique(rec.addresses, [opts.address]);
  await storage.set({ [ORIGINS_KEY]: map });
}

/** Revoke ONE site: clear its consent record entirely (it must re-request to reconnect). */
export async function revokeOrigin(storage: StorageLike, origin: string): Promise<OriginsMap> {
  return setOriginApproval(storage, origin, false);
}

/** Revoke ALL sites: clear every consent record. */
export async function revokeAllOrigins(storage: StorageLike): Promise<void> {
  await storage.set({ [ORIGINS_KEY]: {} });
}

/** The EIP-2255-shaped `window.chia` permission methods (bare + `wallet_`-prefixed aliases). */
export const PERMISSION_GET_METHODS = new Set(['wallet_getPermissions', 'getPermissions']);
export const PERMISSION_REVOKE_METHODS = new Set(['wallet_revokePermissions', 'revokePermissions']);

/**
 * Classify a method as `get` / `revoke` permission-management, or `null`. Robust to the provider's
 * `normalizeMethod`, which namespaces any bare method to `chip0002_<name>` — so the SW recognizes
 * BOTH the raw dApp call (`wallet_getPermissions`) and its normalized wire form
 * (`chip0002_wallet_getPermissions`). Any leading `chip0002_`/`chia_` is stripped before matching.
 */
export function permissionBucket(method: string): 'get' | 'revoke' | null {
  const bare = String(method || '').replace(/^chip0002_/, '').replace(/^chia_/, '');
  if (PERMISSION_GET_METHODS.has(bare)) return 'get';
  if (PERMISSION_REVOKE_METHODS.has(bare)) return 'revoke';
  return null;
}

/** True if `method` is one of the EIP-2255-shaped permission-management methods (raw or normalized). */
export function isPermissionMethod(method: string): boolean {
  return permissionBucket(method) !== null;
}

/** Render a permission into the EIP-2255 object shape a dApp expects (Chia-mapped caveat). */
function permissionToEip2255(perm: OriginPermission): {
  invoker: string;
  parentCapability: string;
  caveats: { type: string; value: string[] }[];
  date: number;
} {
  return {
    invoker: perm.origin,
    parentCapability: 'chia_connect',
    caveats: [{ type: 'restrictReturnedAddresses', value: perm.addresses }],
    date: perm.grantedAt,
  };
}

/**
 * Handle a `window.chia` permission-management method against the shared consent store (works for both
 * the custody and the WalletConnect→Sage paths, since both share `wallet.origins`):
 *   - `wallet_getPermissions` → an EIP-2255 array (empty when the origin has no grant),
 *   - `wallet_revokePermissions` → clears the origin's consent (a revoked site must re-request).
 */
export async function handlePermissionMethod(
  storage: StorageLike,
  method: string,
  origin: string,
): Promise<BrokerEnvelope> {
  if (!origin) return err(400, 'Missing origin');
  const bucket = permissionBucket(method);
  if (bucket === 'get') {
    const map = await getApprovedOrigins(storage);
    const perm = toPermission(origin, map[origin]);
    return ok(perm ? [permissionToEip2255(perm)] : []);
  }
  if (bucket === 'revoke') {
    await revokeOrigin(storage, origin);
    return ok({ revoked: true });
  }
  return err(404, `Unsupported method: ${method}`);
}
