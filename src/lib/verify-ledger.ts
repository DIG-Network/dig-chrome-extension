// The server-side VERIFICATION LEDGER the extension consumes from the local dig-node
// (`GET /verify/<storeId>[:<root>]`, dig-node §4.7 / #307). Where `dig-ledger.ts` is the
// CLIENT-recorded per-resource ledger the loader accrues, THIS is the AUTHORITATIVE
// server-side record: the node verified every `/s/`-served resource against the store's
// chain-anchored root (fail-closed) and retains each verdict + its Merkle inclusion-proof
// data. The Shield panel renders the aggregate "Verified by Chia" badge + a proof-inspection
// modal from it.
//
// This module is the PURE model behind that surface: the wire types, a defensive normalizer
// for the node response (never trust `any` from the network — §6.4 wire-boundary rule), the
// aggregate rule (green only when every resource verified; "Unverified" when any RPC resource
// failed), and a client-side proof re-verification that folds a leaf up through its sibling
// path using the SAME domain-separated hash digstore commits with:
//   internal node = SHA-256("digstore:node:v1" || left || right)   (digstore-core merkle.rs)
//   leaf          = SHA-256(resource_ciphertext)                    (the `leafHash` the node gives us)
//
// No chrome.* / DOM — importable by the popup, tests, and (types) the background SW. The hash
// uses WebCrypto `crypto.subtle` (present in the extension popup and in the Node ≥18 test env).

/** The tier a resource was served from, per the node ledger. */
export type VerifySource = 'local' | 'peer' | 'rpc';

/** One bottom-up inclusion-proof step: the sibling hash and which side it sits on. */
export interface VerifySibling {
  hash: string;
  /** `left` → sibling is the LEFT node (fold `hash(sibling, acc)`); `right` → RIGHT (`hash(acc, sibling)`). */
  dir: 'left' | 'right';
}

/** The Merkle inclusion proof for one resource (enough to DISPLAY and to re-verify client-side). */
export interface VerifyProof {
  /** `SHA-256(resource ciphertext)` — the D5 per-resource leaf. */
  leafHash: string;
  /** The bottom-up sibling path in fold order. */
  siblings: VerifySibling[];
  /** The leaf's index, reconstructed from the sibling directions (DISPLAY only — never re-verified). */
  leafIndex: number;
  /** The root the proof folds to. For a verified entry `proofRoot === root`. */
  proofRoot: string;
}

/** One resource's server-side verdict + proof data. */
export interface VerifyResource {
  resourceKey: string;
  source: VerifySource;
  verified: boolean;
  /** The chain-anchored root this entry served against. */
  root: string;
  proof: VerifyProof;
  /** A catalogued reason when `verified === false`; `null`/absent on a pass. */
  failReason?: string | null;
}

/** Per-tier entry counts. */
export interface VerifyCounts {
  total: number;
  verified: number;
  failed: number;
  bySource: { local: number; peer: number; rpc: number };
}

/** The page-level aggregate verdict. */
export interface VerifyAggregate {
  /** Non-empty AND every entry verified. The badge is green "Verified by Chia" only when true. */
  verified: boolean;
  /** Any entry with `source === "rpc" && !verified` — the load-bearing "Unverified" trigger. */
  anyRpcFailed: boolean;
  counts: VerifyCounts;
}

/** The full `GET /verify` response. */
export interface VerifyLedger {
  storeId: string;
  root: string;
  aggregate: VerifyAggregate;
  resources: VerifyResource[];
}

/** Domain-separation tag for an internal Merkle node — byte-identical to digstore-core `NODE_TAG`. */
export const NODE_TAG = 'digstore:node:v1';

const HEX64 = /^[0-9a-f]{64}$/;

function lowerHex(s: unknown): string {
  return String(s ?? '').toLowerCase();
}

function isSource(s: unknown): s is VerifySource {
  return s === 'local' || s === 'peer' || s === 'rpc';
}

/**
 * Recompute the aggregate verdict from a resource list per the normative dig-node rules (§4.7):
 * `verified` = non-empty AND every entry verified; `anyRpcFailed` = any failed RPC entry. Used both
 * to validate/repair the node's own aggregate and as the single testable source of the badge rule.
 */
export function deriveAggregate(resources: readonly VerifyResource[]): VerifyAggregate {
  const bySource = { local: 0, peer: 0, rpc: 0 };
  let verifiedCount = 0;
  let anyRpcFailed = false;
  for (const r of resources) {
    if (isSource(r.source)) bySource[r.source] += 1;
    if (r.verified) verifiedCount += 1;
    else if (r.source === 'rpc') anyRpcFailed = true;
  }
  const total = resources.length;
  return {
    verified: total > 0 && verifiedCount === total,
    anyRpcFailed,
    counts: { total, verified: verifiedCount, failed: total - verifiedCount, bySource },
  };
}

function normalizeProof(raw: unknown): VerifyProof {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const siblings = Array.isArray(p.siblings)
    ? p.siblings.map((s): VerifySibling => {
        const so = (s && typeof s === 'object' ? s : {}) as Record<string, unknown>;
        return { hash: lowerHex(so.hash), dir: so.dir === 'left' ? 'left' : 'right' };
      })
    : [];
  return {
    leafHash: lowerHex(p.leafHash),
    siblings,
    leafIndex: Number.isFinite(p.leafIndex as number) ? Number(p.leafIndex) : 0,
    proofRoot: lowerHex(p.proofRoot),
  };
}

function normalizeResource(raw: unknown): VerifyResource {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const failReason = r.failReason == null ? null : String(r.failReason);
  return {
    resourceKey: String(r.resourceKey ?? ''),
    source: isSource(r.source) ? r.source : 'rpc',
    verified: r.verified === true,
    root: lowerHex(r.root),
    proof: normalizeProof(r.proof),
    failReason,
  };
}

/**
 * Normalize + validate a raw `GET /verify` response into a {@link VerifyLedger}. Narrows at the
 * wire boundary: lowercases hex, coerces the arrays, defaults an unknown `source` to `rpc`
 * (fail-closed — an unknown tier is treated as the untrusted one), and ALWAYS recomputes the
 * aggregate from the resources so the badge can never trust a malformed/absent node aggregate.
 * Any garbage (null, non-object) yields a well-formed EMPTY ledger rather than throwing.
 */
export function normalizeVerifyLedger(raw: unknown): VerifyLedger {
  const l = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const resources = Array.isArray(l.resources) ? l.resources.map(normalizeResource) : [];
  return {
    storeId: lowerHex(l.storeId),
    root: lowerHex(l.root),
    aggregate: deriveAggregate(resources),
    resources,
  };
}

/** Is `s` exactly 64 hex chars (a well-formed 32-byte hash)? */
export function isHex64(s: unknown): boolean {
  return HEX64.test(lowerHex(s));
}

function hexToBytes(hex: string): Uint8Array {
  const h = hex.length % 2 === 0 ? hex : '0' + hex;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

/** SHA-256("digstore:node:v1" || left || right) — the digstore internal-node fold. */
async function hashNode(left: string, right: string): Promise<string> {
  const tag = new TextEncoder().encode(NODE_TAG);
  const l = hexToBytes(left);
  const r = hexToBytes(right);
  const buf = new Uint8Array(tag.length + l.length + r.length);
  buf.set(tag, 0);
  buf.set(l, tag.length);
  buf.set(r, tag.length + l.length);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return bytesToHex(new Uint8Array(digest));
}

/**
 * Independently re-verify a proof CLIENT-side: fold `leafHash` up through `siblings` with the
 * domain-separated node hash and check the result equals `proofRoot`. `dir === "left"` folds
 * `hash(sibling, acc)`; `dir === "right"` folds `hash(acc, sibling)`. A leaf with no siblings is
 * its own root. Returns the computed root + whether it matches `proofRoot` — the caller then also
 * checks `proofRoot === root` (the chain-anchored root) for a full trust decision.
 */
export async function reverifyProof(proof: VerifyProof): Promise<{ computedRoot: string; ok: boolean }> {
  let acc = lowerHex(proof.leafHash);
  for (const s of proof.siblings || []) {
    const sib = lowerHex(s.hash);
    acc = s.dir === 'left' ? await hashNode(sib, acc) : await hashNode(acc, sib);
  }
  return { computedRoot: acc, ok: acc === lowerHex(proof.proofRoot) };
}
