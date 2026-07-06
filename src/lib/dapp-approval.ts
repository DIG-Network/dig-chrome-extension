/**
 * dApp `walletRpc` custody router + approval queue (#56 §5.5) — the SW-side core behind the
 * SW-summoned approval window for the self-custody wallet.
 *
 * When a webpage's `window.chia` request reaches the service worker, this module decides what to do:
 *   - **connect** → per-origin consent gate (reuses the same consent the Sage broker used): an
 *     unapproved origin is recorded + returns `202 pending` (the user approves out-of-band); an
 *     approved origin returns the wallet address (or a locked-class error).
 *   - **read** (`getPublicKeys` / `getAddress` / `chainId`) → straight to the offscreen vault; no
 *     approval window (nothing is authorized).
 *   - **sign / message** (`signCoinSpends` / `signMessage`) → ENQUEUE the request and summon the
 *     approval window (`chrome.windows.create`, injected as `summonWindow`); the request promise
 *     stays pending until the window returns a decision. Approve → the vault signs (the key never
 *     leaves the offscreen document) and the promise resolves with the signature; reject → an error.
 *   - **unsupported** (a known wallet method not yet wired to custody) → an honest `501`, never a
 *     silent sign.
 *
 * The decoded approval SUMMARY is derived FROM THE BUILT SPEND by the vault (`decodeDappSpend`),
 * never from page-supplied text (§5.5 tamper resistance). Pure/chrome-free: consent lookups, the
 * vault call, and the window summon are injected so this is unit-tested without chrome.* (see
 * tests/dapp-approval.test.mjs). The queue lives in SW memory; a keepalive port from the window
 * keeps the SW + offscreen vault alive through review.
 */

import { normalizeMethod, isSupportedMethod } from './wallet-methods';
import { ok, pending, err, type BrokerEnvelope } from './wallet-broker';

/** A response from the offscreen vault (only the fields this router reads; extra keys tolerated). */
export interface VaultResponse {
  success?: boolean;
  code?: string;
  message?: string;
  address?: string;
  publicKeys?: unknown;
  signature?: unknown;
  signerPublicKey?: unknown;
  dappSummary?: unknown;
  [k: string]: unknown;
}
/** A request forwarded to the offscreen vault. */
export interface VaultRequest {
  op: string;
  [k: string]: unknown;
}
/** The chrome-facing dependencies injected into {@link DappApprovalManager}. */
export interface DappApprovalDeps {
  isOriginApproved(origin: string): Promise<boolean>;
  recordPendingOrigin(origin: string): Promise<void>;
  callVault(request: VaultRequest): Promise<VaultResponse>;
  summonWindow(): Promise<void> | void;
  gapLimit?: number;
  randomId?: () => string;
}
/** One queued approval-gated request (SW-memory only; never sent raw to the window). */
export interface QueueEntry {
  id: string;
  origin: string;
  method: string;
  kind: 'signCoinSpends' | 'signMessage';
  params: { coinSpends?: unknown; message?: string; publicKey?: unknown };
  summary?: unknown;
  needsUnlock?: boolean;
  decodeError?: boolean;
  createdAt: number;
  resolve: (value: BrokerEnvelope) => void;
}
/** A raw `window.chia` request param object (tolerant of shapes). */
type RpcParams = Record<string, unknown> | null | undefined;

/** Read methods routed straight to the vault (no approval — nothing is authorized). */
export const CUSTODY_READ_METHODS = new Set(['chip0002_chainId', 'chip0002_getPublicKeys', 'chia_getAddress']);
/** Coin-spend signing (approval-gated) — a spend the dApp built, signed by the custody key. */
export const CUSTODY_SIGN_METHODS = new Set(['chip0002_signCoinSpends']);
/** Message signing (approval-gated). */
export const CUSTODY_MESSAGE_METHODS = new Set(['chip0002_signMessage', 'chia_signMessageByAddress']);

/**
 * Bucket a `window.chia` method for the custody router: `connect` | `read` | `sign` | `message` |
 * `unsupported` (a known wallet method not yet wired to custody) | `unknown` (not a wallet method).
 * @param {string} method
 * @returns {'connect'|'read'|'sign'|'message'|'unsupported'|'unknown'}
 */
export function classifyCustodyMethod(
  method: string,
): 'connect' | 'read' | 'sign' | 'message' | 'unsupported' | 'unknown' {
  const norm = normalizeMethod(method);
  if (norm === 'chip0002_connect') return 'connect';
  if (CUSTODY_READ_METHODS.has(norm)) return 'read';
  if (CUSTODY_SIGN_METHODS.has(norm)) return 'sign';
  if (CUSTODY_MESSAGE_METHODS.has(norm)) return 'message';
  if (isSupportedMethod(norm)) return 'unsupported';
  return 'unknown';
}

/** Extract dApp-supplied coin spends from a signCoinSpends param object (tolerant of shapes). */
function extractCoinSpends(params: RpcParams): unknown[] | null {
  if (!params) return null;
  const cs = params.coinSpends ?? params.coin_spends ?? params.spends;
  return Array.isArray(cs) && cs.length > 0 ? cs : null;
}

let _seq = 0;
const defaultId = () => `dapp-${Date.now()}-${++_seq}`;

/**
 * Owns the per-request approval queue + the routing decisions. One instance lives in the service
 * worker. Construct with the injected chrome-facing deps:
 *   - `isOriginApproved(origin) → Promise<boolean>`
 *   - `recordPendingOrigin(origin) → Promise<void>`
 *   - `callVault(request) → Promise<VaultResponse>`   (forwards to the offscreen vault)
 *   - `summonWindow() → Promise<void>`                (chrome.windows.create / focus)
 *   - `gapLimit?: number`, `randomId?: () => string`
 */
export class DappApprovalManager {
  private deps: DappApprovalDeps;
  /** pendingId → the queued entry (SW memory). */
  private queue: Map<string, QueueEntry>;

  constructor(deps: DappApprovalDeps) {
    this.deps = deps;
    this.queue = new Map();
  }

  size(): number {
    return this.queue.size;
  }

  /** The public (window-facing) view of the queue: no raw params, no resolver. */
  list() {
    return [...this.queue.values()].map((e) => ({
      id: e.id,
      origin: e.origin,
      method: e.method,
      kind: e.kind,
      summary: e.summary ?? null,
      needsUnlock: !!e.needsUnlock,
      decodeError: !!e.decodeError,
      createdAt: e.createdAt,
    }));
  }

  /**
   * Fill in the decoded summary for each queued coin-spend request (from the BUILT spend, via the
   * vault). Called by the window before it lists — so a wallet unlocked after the request appears
   * gets its summary on the next refresh. A locked wallet is flagged `needsUnlock` (never signed).
   */
  async enrich() {
    for (const e of this.queue.values()) {
      if (e.kind !== 'signCoinSpends' || e.summary) continue;
      const dec = await this.deps.callVault({ op: 'decodeDappSpend', coinSpends: e.params.coinSpends, gapLimit: this.deps.gapLimit });
      if (dec && dec.success !== false && dec.dappSummary) {
        e.summary = dec.dappSummary;
        e.needsUnlock = false;
        e.decodeError = false;
      } else if (dec && dec.code === 'LOCKED') {
        e.needsUnlock = true;
      } else {
        e.decodeError = true;
      }
    }
  }

  /** Route one `window.chia` request. Resolves immediately for read/connect; for sign/message the
   *  returned promise stays pending until {@link resolveApproval}. */
  async route({
    method,
    params,
    origin,
  }: {
    method: string;
    params?: RpcParams;
    origin?: string;
  }): Promise<BrokerEnvelope> {
    if (!origin) return err(400, 'Missing origin');
    const kind = classifyCustodyMethod(method);
    const norm = normalizeMethod(method);

    if (kind === 'connect') {
      const approved = await this.deps.isOriginApproved(origin);
      if (!approved) {
        await this.deps.recordPendingOrigin(origin);
        return pending();
      }
      const res = await this.deps.callVault({ op: 'getReceiveAddress' });
      if (!res || res.success === false) return err(401, 'Wallet is locked — unlock it in the DIG extension');
      return ok({ address: res.address, network: 'mainnet' });
    }

    // Every non-connect method requires an already-connected (approved) origin.
    if (!(await this.deps.isOriginApproved(origin))) {
      return err(401, 'Not connected — call chia.connect() first');
    }

    if (kind === 'read') return await this.#routeRead(norm);
    if (kind === 'sign') {
      const coinSpends = extractCoinSpends(params);
      if (!coinSpends) return err(400, 'signCoinSpends requires coinSpends');
      return this.#enqueue({ origin, method: norm, kind: 'signCoinSpends', params: { coinSpends } });
    }
    if (kind === 'message') {
      const message = params && (params.message ?? params.msg);
      if (message == null) return err(400, 'signMessage requires a message');
      const publicKey = params && (params.publicKey ?? params.public_key);
      const summary = { message: String(message), publicKey: publicKey || null };
      return this.#enqueue({ origin, method: norm, kind: 'signMessage', params: { message: String(message), publicKey }, summary });
    }
    if (kind === 'unsupported') return err(501, `Method ${norm} is not yet supported by the custody wallet`);
    return err(404, `Unsupported method: ${norm}`);
  }

  async #routeRead(norm: string): Promise<BrokerEnvelope> {
    if (norm === 'chip0002_chainId') return ok('mainnet');
    if (norm === 'chia_getAddress') {
      const r = await this.deps.callVault({ op: 'getReceiveAddress' });
      if (!r || r.success === false) return this.#lockedOr(r);
      return ok(r.address);
    }
    if (norm === 'chip0002_getPublicKeys') {
      const r = await this.deps.callVault({ op: 'getPublicKeys', gapLimit: this.deps.gapLimit });
      if (!r || r.success === false) return this.#lockedOr(r);
      return ok(r.publicKeys);
    }
    return err(404, `Unsupported method: ${norm}`);
  }

  #lockedOr(r: VaultResponse | null | undefined): BrokerEnvelope {
    if (r && r.code === 'LOCKED') return err(401, 'Wallet is locked — unlock it in the DIG extension');
    return err(502, (r && r.message) || 'Wallet request failed');
  }

  /** Register a request needing approval, summon the window, and return the pending decision promise. */
  #enqueue({
    origin,
    method,
    kind,
    params,
    summary,
  }: {
    origin: string;
    method: string;
    kind: QueueEntry['kind'];
    params: QueueEntry['params'];
    summary?: unknown;
  }): Promise<BrokerEnvelope> {
    const id = (this.deps.randomId || defaultId)();
    return new Promise<BrokerEnvelope>((resolve) => {
      this.queue.set(id, { id, origin, method, kind, params, summary, createdAt: Date.now(), resolve });
      // Summon AFTER registering so the window's first list() includes this request.
      Promise.resolve(this.deps.summonWindow()).catch(() => {});
    });
  }

  /**
   * Apply the window's decision for one queued request. Approve → the vault signs (key stays in the
   * offscreen document) and the original request promise resolves with the signature; reject → it
   * resolves with a user-rejection error. Returns an ack with the remaining queue size.
   */
  async resolve(
    id: string,
    approved: boolean,
  ): Promise<{ success: boolean; code?: string; message?: string; remaining?: number }> {
    const entry = this.queue.get(id);
    if (!entry) return { success: false, code: 'NO_PENDING', message: 'no such request' };
    this.queue.delete(id);
    if (!approved) {
      entry.resolve(err(401, 'User rejected the request'));
      return { success: true, remaining: this.queue.size };
    }
    entry.resolve(await this.#performApproved(entry));
    return { success: true, remaining: this.queue.size };
  }

  async #performApproved(entry: QueueEntry): Promise<BrokerEnvelope> {
    if (entry.kind === 'signCoinSpends') {
      const res = await this.deps.callVault({ op: 'signDappSpend', coinSpends: entry.params.coinSpends, gapLimit: this.deps.gapLimit });
      if (!res || res.success === false) {
        return err(res && res.code === 'MISSING_KEY' ? 401 : 502, (res && res.message) || 'signing failed');
      }
      return ok(res.signature);
    }
    if (entry.kind === 'signMessage') {
      const res = await this.deps.callVault({ op: 'signMessage', message: entry.params.message, publicKey: entry.params.publicKey, gapLimit: this.deps.gapLimit });
      if (!res || res.success === false) return this.#lockedOr(res);
      return ok({ signature: res.signature, publicKey: res.signerPublicKey });
    }
    return err(500, 'unknown request kind');
  }
}
