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
 *   - **unsupported** (a known wallet method not yet wired to custody) → an honest `404`
 *     (→ CHIP-0002 4004 METHOD_NOT_FOUND), never a silent sign.
 *
 * The decoded approval SUMMARY is derived FROM THE BUILT SPEND by the vault (`decodeDappSpend`),
 * never from page-supplied text (§5.5 tamper resistance). Pure/chrome-free: consent lookups, the
 * vault call, and the window summon are injected so this is unit-tested without chrome.* (see
 * tests/dapp-approval.test.mjs). The queue lives in SW memory; a keepalive port from the window
 * keeps the SW + offscreen vault alive through review.
 */

import { normalizeMethod, isSupportedMethod } from './wallet-methods';
import { ok, pending, err, type BrokerEnvelope } from './wallet-broker';
import type { OriginRisk } from './phishing';

/** Neutral verdict used when no origin-risk assessor is injected. */
const OK_RISK: OriginRisk = { verdict: 'ok', reason: null };

/**
 * The HTTP-like envelope status the router returns when the USER explicitly rejected a request in the
 * approval window. It maps to CHIP-0002 **4002 USER_REJECTED** in the provider's `mapEnvelopeToError`
 * (the "any other non-2xx → 4002 wallet-side rejection" branch) — DISTINCT from the 401 a locked /
 * not-connected wallet returns (which maps to 4001 UNAUTHORIZED). Overloading 401 for a user reject
 * (as the pre-#119 code did) made a dApp unable to tell "the user said no" from "you're not
 * authorized"; this dedicated status keeps the two error classes separate. Chosen as a 4xx value the
 * provider does not special-case (not 400/401/403/404/429), so it deterministically lands on 4002.
 */
export const USER_REJECTED_STATUS = 499;

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
  /** Phishing/lookalike assessment for an origin (#67 P0-2). Absent → every origin is treated `ok`. */
  assessOrigin?(origin: string): Promise<OriginRisk> | OriginRisk;
  randomId?: () => string;
}
/** One queued approval-gated request (SW-memory only; never sent raw to the window). */
export interface QueueEntry {
  id: string;
  origin: string;
  method: string;
  kind: ApprovalKind;
  /** Kind-specific extracted params (coinSpends/message for sign; recipient/amount/offerStr/… for writes). */
  params: Record<string, unknown>;
  summary?: unknown;
  /** Vault-held prepared spend/trade id (send/takeOffer/cancelOffer) — set during {@link DappApprovalManager.enrich}. */
  pendingId?: string;
  /** createOffer: the offer built during enrich, held in SW memory and released to the dApp ONLY on approve. */
  built?: { offer?: string };
  /** A build (vault call) is in flight for this entry — guards enrich from re-spawning it each poll. */
  building?: boolean;
  needsUnlock?: boolean;
  decodeError?: boolean;
  /** Phishing/lookalike verdict for the requesting origin (#67 P0-2), shown as an interstitial. */
  originRisk?: OriginRisk;
  createdAt: number;
  resolve: (value: BrokerEnvelope) => void;
}
/** A raw `window.chia` request param object (tolerant of shapes). */
type RpcParams = Record<string, unknown> | null | undefined;

/**
 * Read methods routed straight to the vault (no approval — nothing is authorized): identity + address
 * + asset-generic balance/coins (any CAT by assetId, both HD schemes) + the NFT list + the
 * `filterUnlockedCoins` predicate (answered in the router).
 */
export const CUSTODY_READ_METHODS = new Set([
  'chip0002_chainId',
  'chip0002_getPublicKeys',
  'chip0002_getAssetBalance',
  'chip0002_getAssetCoins',
  'chip0002_filterUnlockedCoins',
  'chia_getAddress',
  'chia_getNfts',
]);
/** Coin-spend signing (approval-gated) — a spend the dApp built, signed by the custody key. */
export const CUSTODY_SIGN_METHODS = new Set(['chip0002_signCoinSpends']);
/** Message signing (approval-gated). */
export const CUSTODY_MESSAGE_METHODS = new Set(['chip0002_signMessage', 'chia_signMessageByAddress']);

/** The approval-window request kinds (the sign/message pair + the value-moving writes). */
export type ApprovalKind = 'signCoinSpends' | 'signMessage' | 'send' | 'sendTransaction' | 'createOffer' | 'takeOffer' | 'cancelOffer';

/**
 * State-changing WRITE methods the wallet BUILDS + BROADCASTS (approval-gated). Each maps a
 * `window.chia` method (normalized) to its approval kind: the wallet builds the spend/offer in the
 * offscreen vault (deriving a tamper-resistant summary FROM THE BUILT artifact), shows it for
 * approval, and only broadcasts / releases it on explicit user confirm.
 */
export const CUSTODY_WRITE_KIND: Readonly<Record<string, ApprovalKind>> = Object.freeze({
  chia_send: 'send',
  chia_sendTransaction: 'sendTransaction',
  chia_createOffer: 'createOffer',
  chia_takeOffer: 'takeOffer',
  chia_cancelOffer: 'cancelOffer',
});

/**
 * Bucket a `window.chia` method for the custody router: `connect` | `read` | `sign` | `message` |
 * `write` (a value-moving build+broadcast) | `unsupported` (a known wallet method not yet wired to
 * custody) | `unknown` (not a wallet method).
 * @param {string} method
 * @returns {'connect'|'read'|'sign'|'message'|'write'|'unsupported'|'unknown'}
 */
export function classifyCustodyMethod(
  method: string,
): 'connect' | 'read' | 'sign' | 'message' | 'write' | 'unsupported' | 'unknown' {
  const norm = normalizeMethod(method);
  if (norm === 'chip0002_connect') return 'connect';
  if (CUSTODY_READ_METHODS.has(norm)) return 'read';
  if (CUSTODY_SIGN_METHODS.has(norm)) return 'sign';
  if (CUSTODY_MESSAGE_METHODS.has(norm)) return 'message';
  if (CUSTODY_WRITE_KIND[norm]) return 'write';
  if (isSupportedMethod(norm)) return 'unsupported';
  return 'unknown';
}

/**
 * Extract a CAT asset id (TAIL, hex) from a CHIP-0002 `{type, assetId}` param object. `null`/absent
 * (native XCH) → `undefined`, so the vault's assetId-based routing treats it as XCH.
 */
function extractAssetId(params: RpcParams): string | undefined {
  if (!params) return undefined;
  const a = params.assetId ?? params.asset_id;
  return a == null ? undefined : String(a);
}

/** Extract dApp-supplied coin spends from a signCoinSpends param object (tolerant of shapes). */
function extractCoinSpends(params: RpcParams): unknown[] | null {
  if (!params) return null;
  const cs = params.coinSpends ?? params.coin_spends ?? params.spends;
  return Array.isArray(cs) && cs.length > 0 ? cs : null;
}

/** A trade-offer leg as the vault's makeOffer expects it (single asset + base-unit string amount). */
function offerLeg(a: Record<string, unknown> | undefined): { asset: { kind: 'xch' } | { kind: 'cat'; assetId: string }; amount: string } | null {
  if (!a || a.amount == null) return null;
  const assetId = a.assetId ?? a.asset_id;
  return {
    asset: assetId == null ? { kind: 'xch' } : { kind: 'cat', assetId: String(assetId) },
    amount: String(a.amount),
  };
}

/**
 * Validate + extract the vault params for one WRITE method from the (already Goby-remapped) dApp
 * params. Returns the extracted params to stash on the queue entry, or an `error` (with an HTTP-like
 * status → CHIP-0002 code) to reject BEFORE any approval window is summoned. Money-safety: a
 * malformed / multi-leg request is refused here, never silently coerced.
 */
export function prepareWriteParams(
  kind: ApprovalKind,
  params: RpcParams,
): { params: Record<string, unknown> } | { error: string; status: number } {
  const p = params || {};
  if (kind === 'send') {
    const recipient = p.address ?? p.to ?? p.recipient;
    if (recipient == null || p.amount == null) return { error: 'send requires a recipient address and amount', status: 400 };
    return {
      params: {
        recipient: String(recipient),
        amount: String(p.amount),
        ...(p.fee != null ? { fee: String(p.fee) } : {}),
        ...(extractAssetId(p) ? { assetId: extractAssetId(p) } : {}),
      },
    };
  }
  if (kind === 'takeOffer' || kind === 'cancelOffer') {
    const offerStr = p.offer ?? p.offerStr ?? p.offer1;
    if (offerStr == null || String(offerStr).length === 0) return { error: `${kind} requires an offer string`, status: 400 };
    return { params: { offerStr: String(offerStr), ...(p.fee != null ? { fee: String(p.fee) } : {}) } };
  }
  if (kind === 'createOffer') {
    // The dApp RPC surface stays restricted to exactly one offered + one requested asset (unchanged
    // by #100, which generalizes the self-custody wallet's OWN Trade UI) — a distinct, narrower
    // surface than the vault engine's wire shape. `offered`/`requested` are wrapped into 1-element
    // ARRAYS below purely to match the vault's #100 `makeOffer` wire contract (`WireOfferLeg[]`).
    const offerAssets = p.offerAssets ?? p.offered;
    const requestAssets = p.requestAssets ?? p.requested;
    if (!Array.isArray(offerAssets) || !Array.isArray(requestAssets) || offerAssets.length !== 1 || requestAssets.length !== 1) {
      return { error: 'createOffer supports exactly one offered and one requested asset', status: 400 };
    }
    const offered = offerLeg(offerAssets[0] as Record<string, unknown>);
    const requested = offerLeg(requestAssets[0] as Record<string, unknown>);
    if (!offered || !requested) return { error: 'createOffer legs require an amount', status: 400 };
    return { params: { offered: [offered], requested: [requested], ...(p.fee != null ? { fee: String(p.fee) } : {}) } };
  }
  if (kind === 'sendTransaction') {
    const bundle = (p.spendBundle ?? p.spend_bundle) as Record<string, unknown> | undefined;
    const coinSpends = bundle && (bundle.coin_spends ?? bundle.coinSpends);
    const aggregatedSignature = bundle && (bundle.aggregated_signature ?? bundle.aggregatedSignature);
    if (!Array.isArray(coinSpends) || coinSpends.length === 0 || !aggregatedSignature) {
      return { error: 'sendTransaction requires a spendBundle with coin_spends and an aggregated_signature', status: 400 };
    }
    return { params: { coinSpends, aggregatedSignature: String(aggregatedSignature) } };
  }
  return { error: `unsupported write ${kind}`, status: 404 };
}

let _seq = 0;
const defaultId = () => `dapp-${Date.now()}-${++_seq}`;

/**
 * Owns the per-request approval queue + the routing decisions. One instance lives in the service
 * worker. Construct with the injected chrome-facing deps:
 *   - `isOriginApproved(origin) → Promise<boolean>`
 *   - `recordPendingOrigin(origin) → Promise<void>`
 *   - `callVault(request) → Promise<VaultResponse>`   (forwards to the offscreen vault; the caller
 *     attaches the CURRENT active derivation index (#165) fresh on every call, so a dApp op always
 *     reads/spends whichever index is active at call time — never a value captured once at startup)
 *   - `summonWindow() → Promise<void>`                (chrome.windows.create / focus)
 *   - `randomId?: () => string`
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
      originRisk: e.originRisk ?? OK_RISK,
      createdAt: e.createdAt,
    }));
  }

  /** Assess an origin via the injected assessor (defaults to `ok` when none is provided). */
  async #risk(origin: string): Promise<OriginRisk> {
    if (!this.deps.assessOrigin) return OK_RISK;
    try {
      return (await this.deps.assessOrigin(origin)) || OK_RISK;
    } catch {
      return OK_RISK;
    }
  }

  /**
   * Build the decoded summary for each queued request (from the BUILT spend/offer, via the vault) so
   * the approval window shows the tamper-resistant facts and holds the exact artifact to be broadcast.
   *
   * NON-BLOCKING per entry: each entry's build runs at most ONCE at a time (an `building` guard), and
   * the returned promise resolves when the in-flight builds settle. The SW's `dappApprovalList` fires
   * this WITHOUT awaiting and returns the current queue immediately, so a slow/unreachable coinset
   * (a send/offer build scans the chain) can never freeze the approval window — the summary streams in
   * on a subsequent poll. Tests `await enrich()` to get summaries populated (the injected vault is
   * instant). A locked wallet is flagged `needsUnlock`; a build failure `decodeError`; both retry on a
   * later poll. `signMessage` needs no build (its summary is set at enqueue).
   */
  async enrich() {
    await Promise.all([...this.queue.values()].map((e) => this.#buildEntry(e)));
  }

  /** Build one queued entry's summary (guarded so a still-running build is not re-spawned each poll). */
  async #buildEntry(e: QueueEntry): Promise<void> {
    if (e.summary || e.building || e.kind === 'signMessage') return;
    e.building = true;
    try {
      switch (e.kind) {
        case 'signCoinSpends':
        case 'sendTransaction': {
          // A dApp-built spend/bundle: decode a tamper-resistant summary from the coin spends.
          const dec = await this.deps.callVault({ op: 'decodeDappSpend', coinSpends: e.params.coinSpends });
          this.#applyBuild(e, dec, dec && dec.dappSummary);
          break;
        }
        case 'send': {
          // Build (not broadcast) the send in the vault; hold it under a pendingId + show its summary.
          const prep = await this.deps.callVault({ op: 'prepareSend', recipient: e.params.recipient, amount: e.params.amount, fee: e.params.fee, assetId: e.params.assetId });
          this.#applyBuild(e, prep, prep && prep.summary, prep && (prep.pendingId as string | undefined));
          break;
        }
        case 'takeOffer':
        case 'cancelOffer': {
          const prep = await this.deps.callVault({ op: 'prepareTrade', offerStr: e.params.offerStr, tradeKind: e.kind === 'takeOffer' ? 'take' : 'cancel', fee: e.params.fee });
          this.#applyBuild(e, prep, prep && prep.offerSummary, prep && (prep.pendingId as string | undefined));
          break;
        }
        case 'createOffer': {
          // Build the offer; hold the offer STRING (released to the dApp only on approve) + show its summary.
          const made = await this.deps.callVault({ op: 'makeOffer', offered: e.params.offered, requested: e.params.requested, fee: e.params.fee });
          if (made && made.success !== false && made.offerSummary) {
            e.summary = made.offerSummary;
            e.built = { offer: made.offer as string | undefined };
            e.needsUnlock = false;
            e.decodeError = false;
          } else if (made && made.code === 'LOCKED') {
            e.needsUnlock = true;
          } else {
            e.decodeError = true;
          }
          break;
        }
      }
    } finally {
      e.building = false;
    }
  }

  /** Apply a build/decode vault result to a queue entry: set the summary (+ optional pendingId), or
   *  flag `needsUnlock` (locked) / `decodeError` (build failed). */
  #applyBuild(e: QueueEntry, res: VaultResponse | null | undefined, summary: unknown, pendingId?: string): void {
    if (res && res.success !== false && summary) {
      e.summary = summary;
      if (pendingId) e.pendingId = pendingId;
      e.needsUnlock = false;
      e.decodeError = false;
    } else if (res && res.code === 'LOCKED') {
      e.needsUnlock = true;
    } else {
      e.decodeError = true;
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
      // Phishing gate (#67 P0-2): a blocklisted origin is refused before it can ever connect —
      // it is never recorded as pending and never approved.
      if (this.deps.assessOrigin) {
        const risk = await this.#risk(origin);
        if (risk.verdict === 'block') return err(403, 'This site is flagged as dangerous and was blocked.');
      }
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

    if (kind === 'read') return await this.#routeRead(norm, params);
    if (kind === 'sign') {
      const coinSpends = extractCoinSpends(params);
      if (!coinSpends) return err(400, 'signCoinSpends requires coinSpends');
      const originRisk = this.deps.assessOrigin ? await this.#risk(origin) : undefined;
      return this.#enqueue({ origin, method: norm, kind: 'signCoinSpends', params: { coinSpends }, originRisk });
    }
    if (kind === 'message') {
      const message = params && (params.message ?? params.msg);
      if (message == null) return err(400, 'signMessage requires a message');
      const publicKey = params && (params.publicKey ?? params.public_key);
      const summary = { message: String(message), publicKey: publicKey || null };
      const originRisk = this.deps.assessOrigin ? await this.#risk(origin) : undefined;
      return this.#enqueue({ origin, method: norm, kind: 'signMessage', params: { message: String(message), publicKey }, summary, originRisk });
    }
    if (kind === 'write') {
      // Value-moving write: validate + extract the vault params FIRST (a malformed request is refused
      // 400 before any window is summoned), then enqueue for approval. The spend/offer is BUILT during
      // enrich (summary decoded from the built artifact) and only broadcast/released on approve.
      const writeKind = CUSTODY_WRITE_KIND[norm];
      const prepared = prepareWriteParams(writeKind, params);
      if ('error' in prepared) return err(prepared.status, prepared.error);
      const originRisk = this.deps.assessOrigin ? await this.#risk(origin) : undefined;
      return this.#enqueue({ origin, method: norm, kind: writeKind, params: prepared.params, originRisk });
    }
    // A known wallet method not yet wired to custody → 404 so the provider surfaces the CHIP-0002
    // 4004 METHOD_NOT_FOUND (reference-parity stubbing), not a 5xx/disconnected class.
    if (kind === 'unsupported') return err(404, `Method ${norm} is not yet supported by the custody wallet`);
    return err(404, `Unsupported method: ${norm}`);
  }

  async #routeRead(norm: string, params?: RpcParams): Promise<BrokerEnvelope> {
    if (norm === 'chip0002_chainId') return ok('mainnet');
    if (norm === 'chia_getAddress') {
      const r = await this.deps.callVault({ op: 'getReceiveAddress' });
      if (!r || r.success === false) return this.#lockedOr(r);
      // Sage-WC2 `getAddress` returns `{ address }` (the provider unwraps either shape).
      return ok({ address: r.address });
    }
    if (norm === 'chip0002_getPublicKeys') {
      const r = await this.deps.callVault({ op: 'getPublicKeys' });
      if (!r || r.success === false) return this.#lockedOr(r);
      return ok(r.publicKeys);
    }
    if (norm === 'chip0002_getAssetBalance') {
      // Asset routing by assetId (any CAT, or native XCH) — forwarded to the vault verbatim so a CAT
      // is never silently treated as XCH (#121 regression guard lives in the vault + this forwarding).
      const r = await this.deps.callVault({ op: 'getAssetBalance', assetId: extractAssetId(params) });
      if (!r || r.success === false) return this.#lockedOr(r);
      return ok(r.assetBalance);
    }
    if (norm === 'chip0002_getAssetCoins') {
      const r = await this.deps.callVault({ op: 'getAssetCoins', assetId: extractAssetId(params) });
      if (!r || r.success === false) return this.#lockedOr(r);
      return ok(r.assetCoins);
    }
    if (norm === 'chip0002_filterUnlockedCoins') {
      // The self-custody wallet holds no coins reserved ACROSS dApp calls (a prepared send is held
      // only briefly, in the vault, during approval), so every supplied coin is unlocked — echo them.
      const coins = (params && (params.coins ?? params.coinNames)) ?? [];
      return ok(coins);
    }
    if (norm === 'chia_getNfts') {
      const r = await this.deps.callVault({ op: 'listNfts' });
      if (!r || r.success === false) return this.#lockedOr(r);
      return ok(r.nfts);
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
    originRisk,
  }: {
    origin: string;
    method: string;
    kind: QueueEntry['kind'];
    params: QueueEntry['params'];
    summary?: unknown;
    originRisk?: OriginRisk;
  }): Promise<BrokerEnvelope> {
    const id = (this.deps.randomId || defaultId)();
    return new Promise<BrokerEnvelope>((resolve) => {
      this.queue.set(id, { id, origin, method, kind, params, summary, originRisk, createdAt: Date.now(), resolve });
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
      // User-rejection precision (#119): a distinct status so the provider surfaces 4002 USER_REJECTED,
      // never the 4001 UNAUTHORIZED that a locked/not-connected wallet returns.
      entry.resolve(err(USER_REJECTED_STATUS, 'User rejected the request'));
      return { success: true, remaining: this.queue.size };
    }
    // #75 — NEVER authorize a request whose spend could not be decoded for review. The approval
    // window already hides Approve on a decodeError; the SW enforces it too (defense in depth): a
    // decode-failed request is refused with an explicit error, never handed to the vault to sign or
    // broadcast — a user can never authorize a spend they could not see.
    if (entry.decodeError) {
      entry.resolve(err(400, 'Refusing to authorize a request that could not be decoded for review'));
      return { success: true, code: 'DECODE_ERROR', remaining: this.queue.size };
    }
    entry.resolve(await this.#performApproved(entry));
    return { success: true, remaining: this.queue.size };
  }

  async #performApproved(entry: QueueEntry): Promise<BrokerEnvelope> {
    switch (entry.kind) {
      case 'signCoinSpends': {
        const res = await this.deps.callVault({ op: 'signDappSpend', coinSpends: entry.params.coinSpends });
        if (!res || res.success === false) {
          return err(res && res.code === 'MISSING_KEY' ? 401 : 502, (res && res.message) || 'signing failed');
        }
        return ok(res.signature);
      }
      case 'signMessage': {
        const res = await this.deps.callVault({ op: 'signMessage', message: entry.params.message as string, publicKey: entry.params.publicKey });
        if (!res || res.success === false) return this.#lockedOr(res);
        return ok({ signature: res.signature, publicKey: res.signerPublicKey });
      }
      case 'send': {
        // Broadcast the EXACT spend built at enrich (whose summary the user approved) — never a rebuild.
        if (!entry.pendingId) return err(502, 'send was not prepared');
        const res = await this.deps.callVault({ op: 'confirmSend', pendingId: entry.pendingId });
        if (!res || res.success === false) return this.#lockedOr(res);
        return ok({ id: res.spentCoinId });
      }
      case 'takeOffer':
      case 'cancelOffer': {
        if (!entry.pendingId) return err(502, 'trade was not prepared');
        const res = await this.deps.callVault({ op: 'confirmTrade', pendingId: entry.pendingId });
        if (!res || res.success === false) return this.#lockedOr(res);
        return ok({ id: res.spentCoinId });
      }
      case 'createOffer': {
        // The offer was built during enrich and held; approval RELEASES the string to the dApp.
        if (!entry.built || !entry.built.offer) return err(502, 'offer was not built');
        return ok({ offer: entry.built.offer });
      }
      case 'sendTransaction': {
        const res = await this.deps.callVault({ op: 'broadcastDappBundle', coinSpends: entry.params.coinSpends, aggregatedSignature: entry.params.aggregatedSignature });
        if (!res || res.success === false) return err(502, (res && res.message) || 'broadcast failed');
        // MempoolInclusionStatus SUCCESS = 1 (the coinset push was accepted).
        return ok([{ status: 1 }]);
      }
      default:
        return err(500, 'unknown request kind');
    }
  }
}
