/**
 * The hardened window.postMessage channel between the MAIN-world injected provider
 * (`dig-provider.js`) and the isolated-world content bridge (`content.js`) — the wallet's
 * outermost trust boundary (#73).
 *
 * Both sides run in the SAME document but in DIFFERENT JS worlds, so `window.postMessage` is the
 * only channel available. It is also observable by ANY script on the page. This module supplies
 * the pure, shared primitives both sides use so that:
 *
 *   - every message is NAMESPACED + VERSIONED (`channel`) and DIRECTIONAL (`type`), so unrelated
 *     postMessage traffic (other libraries, framework buses) is cleanly ignored rather than
 *     mis-parsed;
 *   - every message is ORIGIN-CHECKED end to end — a handler drops any message whose delivered
 *     `event.origin` differs from the document's own origin (a cross-origin/foreign-frame message
 *     is never processed), in addition to the `event.source === window` frame guard the callers
 *     apply;
 *   - request ids come from the CSPRNG (`crypto.getRandomValues`), never `Math.random`, so
 *     concurrent in-flight requests cannot collide and an id is not cheaply predictable;
 *   - responses are CORRELATED to their request id through a BOUNDED registry that settles each id
 *     exactly ONCE — a forged reply for an unknown id is dropped, a duplicate/replayed reply is a
 *     no-op, concurrent multiplexed requests never cross, and a request flood cannot grow the
 *     pending map without bound (no unbounded listeners / memory);
 *   - malformed input is DROPPED, never thrown on — a hostile page cannot break the bridge with a
 *     junk payload.
 *
 * Pure (no chrome.* / DOM globals beyond `crypto`), so it is fully unit-tested and BOTH the
 * esbuild-bundled provider entry and the esbuild-bundled content script inline it.
 */
import { BRIDGE } from './messages';

/** Namespace tag on every channel message — distinguishes wallet traffic from any other postMessage. */
export const PROVIDER_CHANNEL = 'dig-wallet/1';

/** Max concurrent in-flight requests the page-side registry will hold (DoS / memory bound). */
export const MAX_INFLIGHT = 256;

/** Max accepted request-id length (a CSPRNG id is 32 chars; the cap rejects oversized junk). */
export const MAX_ID_LEN = 64;

/** Max accepted method-name length (the longest real CHIP-0002 method is well under this). */
export const MAX_METHOD_LEN = 128;

/** The wallet reply envelope the content bridge relays back from the background service worker. */
export interface WalletEnvelope {
  status: number;
  body?: { data?: unknown; error?: string };
  error?: string;
}

/** page → content: a CHIP-0002 wallet RPC. */
export interface RequestEnvelope {
  channel: typeof PROVIDER_CHANNEL;
  type: typeof BRIDGE.WALLET_REQUEST;
  id: string;
  method: string;
  params: Record<string, unknown>;
}

/** content → page: the wallet reply, correlated to a request `id`. */
export interface ResponseEnvelope {
  channel: typeof PROVIDER_CHANNEL;
  type: typeof BRIDGE.WALLET_RESPONSE;
  id: string;
  status: number;
  body?: WalletEnvelope['body'];
  error?: string;
}

/** The correlated fields a validated inbound request yields. */
export interface InboundRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

/** The correlated fields a validated inbound response yields. */
export interface InboundResponse {
  id: string;
  status: number;
  body?: WalletEnvelope['body'];
  error?: string;
}

/** A 128-bit CSPRNG request id as lowercase hex (32 chars). */
export function newRequestId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/** Build a page→content request envelope. */
export function buildRequest(id: string, method: string, params?: Record<string, unknown>): RequestEnvelope {
  return {
    channel: PROVIDER_CHANNEL,
    type: BRIDGE.WALLET_REQUEST,
    id,
    method,
    params: params && typeof params === 'object' ? params : {},
  };
}

/** Build a content→page response envelope correlated to `id`. */
export function buildResponse(id: string, envelope: WalletEnvelope | null | undefined): ResponseEnvelope {
  return {
    channel: PROVIDER_CHANNEL,
    type: BRIDGE.WALLET_RESPONSE,
    id,
    status: (envelope && envelope.status) ?? 0,
    body: envelope ? envelope.body : undefined,
    error: envelope ? envelope.error : undefined,
  };
}

/**
 * The `targetOrigin` to post a reply/request with so delivery is restricted to the document's own
 * origin. An opaque origin (a sandboxed / `data:` document) reports `"null"`, which is an INVALID
 * targetOrigin that throws — such a document must fall back to `"*"`.
 */
export function postTargetOrigin(selfOrigin: string): string {
  return selfOrigin && selfOrigin !== 'null' ? selfOrigin : '*';
}

/** True when `v` is a non-null object (a valid envelope carrier). */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** True when `s` is a non-empty string no longer than `max`. */
function isBoundedString(s: unknown, max: number): s is string {
  return typeof s === 'string' && s.length > 0 && s.length <= max;
}

/**
 * Validate an inbound page→content message as a well-formed, SAME-ORIGIN request. Returns the
 * correlated `{ id, method, params }` or `null` if anything is malformed, cross-origin, or the
 * wrong channel/direction. NEVER throws.
 *
 * @param data        the `MessageEvent.data`
 * @param eventOrigin the delivered `MessageEvent.origin`
 * @param selfOrigin  the document's own origin (`window.location.origin`)
 */
export function parseInboundRequest(data: unknown, eventOrigin: string, selfOrigin: string): InboundRequest | null {
  if (eventOrigin !== selfOrigin) return null;
  if (!isRecord(data)) return null;
  if (data.channel !== PROVIDER_CHANNEL) return null;
  if (data.type !== BRIDGE.WALLET_REQUEST) return null;
  if (!isBoundedString(data.id, MAX_ID_LEN)) return null;
  if (!isBoundedString(data.method, MAX_METHOD_LEN)) return null;
  const params = isRecord(data.params) ? (data.params as Record<string, unknown>) : {};
  return { id: data.id, method: data.method, params };
}

/**
 * Validate an inbound content→page message as a well-formed, SAME-ORIGIN response. Returns the
 * correlated `{ id, status, body, error }` or `null` if malformed, cross-origin, or the wrong
 * channel/direction. NEVER throws.
 */
export function parseInboundResponse(data: unknown, eventOrigin: string, selfOrigin: string): InboundResponse | null {
  if (eventOrigin !== selfOrigin) return null;
  if (!isRecord(data)) return null;
  if (data.channel !== PROVIDER_CHANNEL) return null;
  if (data.type !== BRIDGE.WALLET_RESPONSE) return null;
  if (!isBoundedString(data.id, MAX_ID_LEN)) return null;
  const status = typeof data.status === 'number' ? data.status : 0;
  const body = isRecord(data.body) ? (data.body as WalletEnvelope['body']) : undefined;
  const error = typeof data.error === 'string' ? data.error : undefined;
  return { id: data.id, status, body, error };
}

/** A registered in-flight request awaiting its correlated response. */
export interface PendingEntry<T> {
  /** Resolve the caller's promise with the settled value. */
  resolve: (value: T) => void;
  /** Optional teardown (e.g. clear the timeout) run exactly once when the entry leaves the map. */
  cleanup?: () => void;
}

/**
 * A bounded, id-correlated registry of in-flight requests. It enforces the response-integrity
 * guarantees of the channel:
 *
 *   - `add` refuses a colliding id (never overwrites an in-flight request) and refuses once the
 *     map is at capacity (a request flood cannot grow it without bound);
 *   - `settle` resolves the matching id EXACTLY once — an unknown-id (forged) response is dropped,
 *     and a duplicate/replayed response for an already-settled id is a no-op;
 *   - because each id is settled independently, concurrent multiplexed requests never cross.
 */
export class PendingRegistry<T> {
  private readonly map = new Map<string, PendingEntry<T>>();

  constructor(private readonly max: number = MAX_INFLIGHT) {}

  /** Number of in-flight requests currently held. */
  get size(): number {
    return this.map.size;
  }

  /** True if `id` is currently in flight. */
  has(id: string): boolean {
    return this.map.has(id);
  }

  /**
   * Register an in-flight request. Returns `false` (the caller should reject/timeout) when the id
   * already exists or the registry is at capacity — never overwrites, never grows past `max`.
   */
  add(id: string, entry: PendingEntry<T>): boolean {
    if (this.map.size >= this.max) return false;
    if (this.map.has(id)) return false;
    this.map.set(id, entry);
    return true;
  }

  /**
   * Settle the request for `id` with `value`, resolving its promise and running its cleanup, then
   * removing it. Returns `false` (dropped) when `id` is unknown — so a forged/duplicate/replayed
   * response can never resolve a request or resolve one twice.
   */
  settle(id: string, value: T): boolean {
    const entry = this.map.get(id);
    if (!entry) return false;
    this.map.delete(id);
    try {
      entry.cleanup?.();
    } finally {
      entry.resolve(value);
    }
    return true;
  }

  /** Run every entry's cleanup and empty the registry (e.g. on teardown). */
  clear(): void {
    for (const entry of this.map.values()) entry.cleanup?.();
    this.map.clear();
  }
}
