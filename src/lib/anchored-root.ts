// anchored-root.ts — WHICH source may supply the chain-anchored root a rootless chia:// read is
// verified against (#2526).
//
// The anchored root is the single value the entire read verification hangs on: `verifyAndDecrypt`
// (verified-content.ts, #2276) refuses any read whose inclusion proof does not fold to it. So the
// question "who is allowed to tell us the root?" is exactly as security-critical as the proof check
// itself — a gate is only ever as strong as the root it gates against.
//
// The defect this closes (#2526): the read path asked the SERVING endpoint's own
// `dig.getAnchoredRoot` first and consulted the independent chain walk only when that call FAILED. An
// endpoint that is both the content host and a hostile answerer could therefore return a fabricated
// root together with content whose proof folds to it, and the fail-closed gate would pass it —
// `verified === true` on attacker-substituted bytes. The endpoint's answer is not evidence about the
// chain; it is a claim by the party the verification exists to distrust (rpc.dig.net and a
// user-configured node alike are ORDINARY nodes, never oracles).
//
// The rule this module enforces: **only the independent chain source may establish the trusted root.**
// The endpoint's answer is never promoted to trusted on its own — at most it CORROBORATES the chain's,
// and a disagreement is recorded (a spoof signal) while the chain's value wins.
//
// Fail direction, deliberately chosen: when the independent chain source is unavailable we return
// `null`, which the caller turns into the pre-existing BLIND/advisory path — content still loads and is
// reported unverified. A brief coinset outage therefore degrades a badge, never the ability to read. The
// opposite choice (accepting the endpoint's unconfirmable claim) would silently re-open the spoof, and
// making an outage FATAL would trap the user on an outage we cannot distinguish from an attack.

import { normalizeRoot } from './trusted-root';

/** Why the returned root is (or is not) trusted — a diagnostic signal, never a verification verdict. */
export type AnchoredRootTrust =
  /** The chain source resolved a root AND the serving endpoint agreed with it. */
  | 'confirmed'
  /** The chain source resolved a root; the endpoint offered nothing (unreachable / -32601). */
  | 'chain-only'
  /** The chain source resolved a root and the endpoint claimed a DIFFERENT one — the chain wins. */
  | 'mismatch'
  /** No independent chain root; nothing may be trusted, whatever the endpoint claimed. */
  | 'unconfirmed';

/** The cross-checked anchored-root outcome. */
export interface AnchoredRootDecision {
  /** The trusted chain-anchored root, or null when no INDEPENDENT source established one. */
  root: string | null;
  trust: AnchoredRootTrust;
}

/**
 * Decide the trusted anchored root from the two candidate answers. Pure — the whole policy of #2526
 * lives here so it is testable without a network.
 *
 * The chain source is authoritative in every row; the endpoint's answer only ever changes the
 * DIAGNOSTIC, never the root. In particular `endpointRoot` alone can never produce a non-null root.
 */
export function decideAnchoredRoot(endpointRoot: unknown, chainRoot: unknown): AnchoredRootDecision {
  const chain = normalizeRoot(chainRoot);
  if (!chain) return { root: null, trust: 'unconfirmed' };
  const endpoint = normalizeRoot(endpointRoot);
  if (!endpoint) return { root: chain, trust: 'chain-only' };
  return { root: chain, trust: endpoint === chain ? 'confirmed' : 'mismatch' };
}

/** The two candidate answers, injected so the policy can be exercised without a node or coinset. */
export interface AnchoredRootSources {
  /** The serving endpoint's `dig.getAnchoredRoot` claim — UNTRUSTED, corroboration only. */
  fromEndpoint: () => Promise<string | null | undefined>;
  /** The independent chain walk (coinset lineage) — the only source that may establish trust. */
  fromChain: () => Promise<string | null | undefined>;
}

/**
 * Resolve the cross-checked anchored root, querying both sources CONCURRENTLY.
 *
 * Concurrency is not just latency: the MV3 service worker can be torn down mid-read, and running the
 * two lookups in parallel keeps the cross-check from adding a second sequential await window in which
 * that can happen. If teardown does cut the work off, this promise simply never settles — the caller
 * never receives a root, so an incomplete verification can never be mistaken for a completed one. A
 * source that throws is treated exactly as a source that answered nothing.
 */
export async function resolveCrossCheckedAnchoredRoot(
  sources: AnchoredRootSources,
): Promise<AnchoredRootDecision> {
  const [endpointRoot, chainRoot] = await Promise.all([
    sources.fromEndpoint().catch(() => null),
    sources.fromChain().catch(() => null),
  ]);
  return decideAnchoredRoot(endpointRoot, chainRoot);
}
