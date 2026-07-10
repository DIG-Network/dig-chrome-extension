// trusted-root.ts — the TRUSTED-root decision for a chia:// content read (#226).
//
// The root a read is verified against MUST come from the CHAIN, never the URN string and never the
// serving host. A ROOTED URN (`…:<root>/…`) pins one immutable generation, so its concrete root IS
// the trusted root. A ROOTLESS URN (`chia://<storeId>/…`, the common "latest" case) has no root in
// the string — its trusted root is the store's chain-ANCHORED tip, resolved out-of-band from the
// local dig-node's `dig.getAnchoredRoot` (which walks the DataStore singleton on coinset.org).
//
// The bug this fixes (#226): the literal string 'latest' was passed straight into `verifyInclusion`
// as the trusted root, so a folded `proof.root` could NEVER equal it → every rootless read reported
// verified=false. These pure, unit-tested helpers replace that with an explicit, FAIL-CLOSED
// decision: no resolvable chain root ⇒ unverified (never silently trusted).

/** The sentinel a rootless URN carries in the read path — the store's mutable current generation. */
export const LATEST_ROOT = 'latest';

/**
 * Normalize a candidate root to a lowercase, 0x-stripped 64-hex string, or null when it is not a
 * concrete 32-byte root — covers '', the 'latest' sentinel, undefined/null, and any malformed or
 * tampered value. This is the single gate that keeps a non-root value from reaching `verifyInclusion`.
 */
export function normalizeRoot(root: unknown): string | null {
  if (typeof root !== 'string') return null;
  const hex = root.replace(/^0x/i, '').toLowerCase();
  return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
}

/**
 * True when the URN carried no concrete root (absent or the 'latest' sentinel) — the case whose
 * trusted root must be resolved from the chain rather than read from the URN.
 */
export function isRootlessRoot(urnRoot: string | null | undefined): boolean {
  return normalizeRoot(urnRoot) === null;
}

/** The trusted root + the fetch-pin root for a read. */
export interface ReadRoots {
  /** The root the inclusion proof MUST fold to for verified=true, or null ⇒ unverifiable (fail-closed). */
  trustedRoot: string | null;
  /** The `root` param for `dig.getContent`: the trusted generation when known, else the 'latest' sentinel. */
  fetchRoot: string;
}

/**
 * Decide the trusted + fetch roots for a read from the URN's root and the chain-anchored root
 * resolved for a rootless URN (null when the URN is rooted OR the anchored root was unresolvable):
 *  - rooted URN                              → trust its concrete root, pin the fetch to it;
 *  - rootless URN + anchored root resolved   → trust + pin to the anchored root;
 *  - rootless URN + anchored unresolvable    → trustedRoot null (fail-closed), fetch 'latest' so the
 *    content still LOADS (it just cannot be proven, and is reported unverified).
 */
export function resolveReadRoots(
  urnRoot: string | null | undefined,
  anchoredRoot: string | null | undefined,
): ReadRoots {
  const rooted = normalizeRoot(urnRoot);
  if (rooted) return { trustedRoot: rooted, fetchRoot: rooted };
  const anchored = normalizeRoot(anchoredRoot);
  if (anchored) return { trustedRoot: anchored, fetchRoot: anchored };
  return { trustedRoot: null, fetchRoot: LATEST_ROOT };
}

/**
 * Final verified verdict: true ONLY when there is a trusted (chain-derived) root AND the wasm
 * inclusion proof folded to it. Fail-closed — an unresolvable trusted root is never trusted, no
 * matter what the serving host returned.
 */
export function decideVerified(trustedRoot: string | null, proofFoldsToTrusted: boolean): boolean {
  return trustedRoot !== null && proofFoldsToTrusted;
}
