/**
 * dig-node SIGN-ON-BEHALF client (#374 / dig-node SPEC §18.21) — the extension's controller for
 * spend/offer/mint/transfer operations in the thin-client model (epic #365). The NODE is the signer
 * + broadcaster: the extension sends the Sage-parity mutation method over the authorized `/ws`
 * transport (SPEC §4.8, paired-token-gated §7.12), and the node BUILDS → SIGNS (native BLS with its
 * custodied key) → VALIDATES (`dig-clvm`) → BROADCASTS on the paired caller's behalf. The extension
 * holds NO key material and constructs NO spend bundles locally — it only issues the authorized op.
 *
 * # Per-op consent (SPEC §18.21 — HARD)
 * A broadcast reaches mainnet ONLY when the op is BOTH authorized (the paired token, attached by the
 * transport) AND explicitly consented for that SPECIFIC operation. The extension keeps ownership of
 * the per-op CONFIRM UX: the caller MUST surface the confirm to the user and only invoke this client
 * on confirmation; the node's `ConsentBroadcaster` then forwards exactly one broadcast. An unconsented
 * op fails closed node-side (nothing is spent). This client therefore never auto-fires — it is called
 * from a confirmed action.
 *
 * PURE + transport-injected (the same seam as `node-custody.ts`), so the mapping is unit-tested
 * against a fake transport and composes with the WS controller's `request()`.
 */

/** Transport for one mutation method — the WS controller's `request(method, params)` (token attached). */
export type NodeSignerTransport = (method: string, params: Record<string, unknown>) => Promise<unknown>;

/**
 * The node mutation method group the extension routes for signing on-behalf (dig-node SPEC §18.9/
 * §18.9a). Reads NEVER route here. Kept as a set so a caller can assert an op is a mutation before
 * requesting a broadcast (defense-in-depth beside the node's own §7.12 gate).
 */
export const NODE_MUTATION_METHODS = new Set<string>([
  'send_xch',
  'bulk_send_xch',
  'send_cat',
  'combine',
  'split',
  'sign_coin_spends',
  'submit_transaction',
  'make_offer',
  'take_offer',
  'cancel_offer',
  'transfer_nfts',
  'bulk_mint_nfts',
  'create_did',
  'transfer_dids',
  'update_did',
  'assign_nfts_to_did',
  'issue_cat',
]);

/** True if `method` is a node mutation the sign-on-behalf path serves. */
export function isNodeMutationMethod(method: string): boolean {
  return NODE_MUTATION_METHODS.has(method);
}

/** The normalized result of a node-signed spend (the Sage `TransactionResponse`, mapped). */
export interface NodeSpendResult {
  /** The network fee reserved by the spend, as a base-unit (mojo) decimal string. */
  fee: string;
  /** The number of coin spends the node built + signed (0 means nothing was constructed). */
  coinSpendCount: number;
  /** The raw node result, for callers that need the full Sage shape (offer strings, ids, …). */
  raw: unknown;
}

/** Parameters for a native-XCH send (base units; the node reserves the fee from XCH). */
export interface SendXchParams {
  address: string;
  amount: string;
  fee: string;
  /** Optional public on-chain memos attached to the recipient CREATE_COIN. */
  memos?: string[];
}

/** Parameters for a CAT send (base units; the fee is paid from XCH). */
export interface SendCatParams {
  assetId: string;
  address: string;
  amount: string;
  fee: string;
}

/** The sign-on-behalf client surface. */
export interface NodeSignerClient {
  /** Send native XCH — the node signs + broadcasts on behalf (`send_xch`, auto_submit). */
  sendXch(params: SendXchParams): Promise<NodeSpendResult>;
  /** Send a CAT — the node signs + broadcasts on behalf (`send_cat`, auto_submit). */
  sendCat(params: SendCatParams): Promise<NodeSpendResult>;
  /**
   * Route an arbitrary mutation method (offers/mint/DID/transfer) to the node signer, auto-submitting
   * on the caller's confirmed consent. Rejects a non-mutation method (a read must not route here).
   */
  signAndBroadcast(method: string, params: Record<string, unknown>): Promise<NodeSpendResult>;
}

/** Map a Sage `TransactionResponse` (or any spend result) into a {@link NodeSpendResult}. */
function toSpendResult(raw: unknown): NodeSpendResult {
  const r = raw as { summary?: { fee?: unknown }; coin_spends?: unknown[] } | null | undefined;
  const feeRaw = r?.summary?.fee;
  const fee = typeof feeRaw === 'string' ? feeRaw : typeof feeRaw === 'number' ? String(feeRaw) : '0';
  const coinSpendCount = Array.isArray(r?.coin_spends) ? r!.coin_spends!.length : 0;
  return { fee, coinSpendCount, raw };
}

/**
 * Build a {@link NodeSignerClient} over the injected transport. The caller is responsible for the
 * per-op confirm UX (SPEC §18.21) — this client issues the authorized, consented op and maps the
 * node's response. `auto_submit: true` requests the node broadcast; the node still gates on per-op
 * consent + the paired token, so an unauthorized/unconsented call fails closed node-side.
 */
export function makeNodeSignerClient(send: NodeSignerTransport): NodeSignerClient {
  async function route(method: string, params: Record<string, unknown>): Promise<NodeSpendResult> {
    if (!isNodeMutationMethod(method)) {
      throw new Error(`${method} is not a node mutation method — reads must not route through the signer`);
    }
    return toSpendResult(await send(method, params));
  }
  return {
    sendXch({ address, amount, fee, memos }) {
      return route('send_xch', { address, amount, fee, memos: memos ?? [], auto_submit: true });
    },
    sendCat({ assetId, address, amount, fee }) {
      return route('send_cat', { asset_id: assetId, address, amount, fee, auto_submit: true });
    },
    signAndBroadcast(method, params) {
      return route(method, { auto_submit: true, ...params });
    },
  };
}
