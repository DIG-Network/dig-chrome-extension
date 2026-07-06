// DIG per-resource inclusion-proof LEDGER — the pure model behind the extension's
// DIG Shields per-capsule proof list (the popup's Shield action).
//
// WHY this exists: the Shield surface shows the AGGREGATE verdict for the active
// tab (verified / failed) plus the capsule (storeId:rootHash) disclosure. But a
// capsule is many resources, each with its OWN Merkle inclusion proof that the
// loader verifies client-side, fail-closed. This module is the SINGLE SOURCE OF
// TRUTH for the *pure* ledger model the Shield panel renders: a per-tab/per-capsule
// accumulator keyed by `storeId:rootHash`, and the pass/fail grouping the panel
// lists under "Verified (N)" / "Failed (M)".
//
// CROSS-MODULE CONTRACT — this is a BYTE-MIRROR of the native DIG Browser's
// dig/shields/dig_ledger.mjs (the #134 proof ledger). The browser's native chia://
// loader keeps the EQUIVALENT accumulator and records the SAME
// {resourcePath, storeId, rootHash, inclusionProofPassed, errorCode} tuple per
// resource. SYSTEM.md "align UX across modules" requires the entry shape, the
// capsule key, the grouping, and the two #134 display models to stay identical
// across the browser, this extension, and the native C++ LedgerStore. Any change
// to those must be made in ALL of them in the same unit of work. In the extension
// the recorder is the dig-viewer (which already computes the inclusion verdict via
// the dig-client WASM); this model never re-verifies — it only RECORDS and GROUPS
// what the loader decided, fail-closed: anything without a positive pass verdict
// counts as failed.
//
// #134 (the browser half, mirrored here) adds the per-resource VERIFICATION PROOFS:
//   - inclusionProofDisplay() — surfaces the proof ROOT the resource leaf was
//     Merkle-proven against + a 'verified against on-chain root' indicator;
//   - executionProofDisplay() — the risc0 execution-proof status from the serving
//     node, kept brutally HONEST: a mock/absent/pending proof is NEVER shown as
//     verified (rpc.dig.net returns MOCK proofs today, and the extension's read
//     path fetches inclusion only — so today every resource honestly reads
//     "execution proof: not provided").
//
// Plain ES module (no chrome.* / DOM) so background.js, the popup, the dig-viewer,
// and `node --test` can all import it.
//
// Run:  node --test tests/   (Node >= 18)

// The default view's resource key: an empty / "/" resource path resolves to
// index.html, matching the loader's content-type mapping + the crypto layer's
// canonical rootless URN default. Kept identical so the ledger lists the SAME path
// the loader keyed the retrieval by.
export const DEFAULT_RESOURCE_KEY = "index.html";

// Bound the per-capsule ledger so a long-lived tab loading thousands of
// subresources can't grow it without limit. The most recent entries are kept
// (oldest evicted) — they are what the user is most likely inspecting.
export const DEFAULT_MAX_ENTRIES = 256;

/**
 * The canonical capsule key — `storeId:rootHash`, lowercased. A rootless /
 * not-yet-resolved capsule keys under `<storeId>:latest` so it still groups
 * cleanly. This MUST match the browser's LedgerStore key and the capsule string the
 * Shield header shows.
 *
 * @param {string} storeId 64-hex store id.
 * @param {string} rootHash 64-hex root, or "" / "latest" when unresolved.
 * @returns {string} `storeId:rootHash` (lowercased).
 */
export function capsuleKey(storeId?: string | null, rootHash?: string | null): string {
  const s = String(storeId || "").toLowerCase();
  const r = String(rootHash || "").toLowerCase();
  return s + ":" + (r && r !== "latest" ? r : "latest");
}

/** One recorded per-resource inclusion-proof verdict (the byte-mirrored #134 ledger entry). */
export interface LedgerEntry {
  resourcePath: string;
  storeId: string;
  rootHash: string;
  inclusionProofPassed: boolean;
  errorCode: string;
  executionProofStatus: string;
}

/** The loose input {@link LedgerStore.record} accepts (any field may be missing at the call site). */
export interface LedgerRecordInput {
  storeId?: string;
  rootHash?: string;
  resourcePath?: string;
  inclusionProofPassed?: boolean;
  errorCode?: string;
  executionProofStatus?: string;
}

/**
 * Normalize a resource path to the form the loader keyed the retrieval by: drop
 * a leading slash; an empty path (or bare "/") is the default view (index.html).
 *
 * @param {string} resourcePath
 * @returns {string}
 */
function normalizeResourcePath(resourcePath?: string | null): string {
  let p = String(resourcePath || "");
  while (p.startsWith("/")) p = p.slice(1);
  return p === "" ? DEFAULT_RESOURCE_KEY : p;
}

/**
 * A per-tab/per-capsule accumulator of inclusion-proof verdicts. The native
 * browser loader keeps the equivalent; this is the testable pure model.
 *
 * Entries are keyed by capsule (`storeId:rootHash`) AND by resourcePath within a
 * capsule: re-serving the same resource UPDATES its verdict rather than
 * appending a duplicate (so a retry that succeeds replaces the earlier failure).
 */
export class LedgerStore {
  private _max: number;
  /** capsuleKey -> Map<resourcePath, entry> (insertion order preserved by Map). */
  private _byCapsule: Map<string, Map<string, LedgerEntry>>;

  constructor(opts: { maxEntries?: number } = {}) {
    this._max =
      Number.isInteger(opts.maxEntries) && (opts.maxEntries as number) > 0
        ? (opts.maxEntries as number)
        : DEFAULT_MAX_ENTRIES;
    this._byCapsule = new Map();
  }

  /**
   * Record one resource's verdict for its capsule. The verdict is whatever the
   * loader already decided — this never re-verifies.
   *
   * @param {object} e
   * @param {string} e.storeId 64-hex store id.
   * @param {string} e.rootHash 64-hex root (or "" / "latest").
   * @param {string} e.resourcePath the served resource path.
   * @param {boolean} e.inclusionProofPassed the loader's per-resource verdict.
   * @param {string} [e.errorCode] a catalogued DIG_ERR_* code on failure ("" on pass).
   */
  record(e: LedgerRecordInput): void {
    const key = capsuleKey(e && e.storeId, e && e.rootHash);
    const resourcePath = normalizeResourcePath(e && e.resourcePath);
    const passed = (e && e.inclusionProofPassed) === true;
    const entry = {
      resourcePath,
      storeId: String((e && e.storeId) || "").toLowerCase(),
      rootHash: String((e && e.rootHash) || "").toLowerCase(),
      inclusionProofPassed: passed,
      // On a pass there is no error; on a fail keep the catalogued code (fall back
      // to a generic proof-mismatch class when the caller didn't supply one).
      errorCode: passed ? "" : String((e && e.errorCode) || ""),
      // #134: carry the raw execution-proof status through so executionProofDisplay
      // can map it honestly. Absent today (the read path fetches inclusion only).
      executionProofStatus: String((e && e.executionProofStatus) || ""),
    };
    let perResource = this._byCapsule.get(key);
    if (!perResource) {
      perResource = new Map();
      this._byCapsule.set(key, perResource);
    }
    // Update-in-place when re-served (re-insert to move it to most-recent).
    perResource.delete(resourcePath);
    perResource.set(resourcePath, entry);
    // Evict the oldest while over the cap.
    while (perResource.size > this._max) {
      const oldest = perResource.keys().next().value;
      if (oldest !== undefined) perResource.delete(oldest);
    }
  }

  /**
   * The recorded entries for one capsule, in insertion (load) order.
   * @param {string} storeId @param {string} rootHash
   * @returns {Array<object>} a fresh array (callers may sort/group freely).
   */
  entriesFor(storeId?: string | null, rootHash?: string | null): LedgerEntry[] {
    const perResource = this._byCapsule.get(capsuleKey(storeId, rootHash));
    return perResource ? Array.from(perResource.values()) : [];
  }
}

/**
 * Group a capsule's ledger entries into PASSED vs FAILED with counts + the
 * derived states the Shield panel branches on. Fail-closed: an entry without a
 * positive `inclusionProofPassed === true` verdict counts as FAILED. Pure — does
 * not mutate its input.
 *
 * @param {Array<object>} entries the ledger entries (from {@link LedgerStore#entriesFor}).
 *   Non-arrays are treated as empty.
 * @returns {{
 *   passed: Array<object>, failed: Array<object>,
 *   passedCount: number, failedCount: number, total: number,
 *   allPassed: boolean, empty: boolean
 * }}
 *   - `empty` — nothing has been recorded for this capsule yet (NOT the same as
 *     all-passed; nothing was verified).
 *   - `allPassed` — there is at least one entry and NONE failed.
 */
export function groupLedger(entries: readonly Partial<LedgerEntry>[] | null | undefined) {
  const list = Array.isArray(entries) ? entries : [];
  const passed: Partial<LedgerEntry>[] = [];
  const failed: Partial<LedgerEntry>[] = [];
  for (const e of list) {
    if (e && e.inclusionProofPassed === true) {
      passed.push(e);
    } else {
      failed.push(e);
    }
  }
  const total = passed.length + failed.length;
  return {
    passed,
    failed,
    passedCount: passed.length,
    failedCount: failed.length,
    total,
    empty: total === 0,
    allPassed: total > 0 && failed.length === 0,
  };
}

/**
 * Is `s` a 64-hex capsule/proof root (the form a resolved rootHash takes)? A
 * rootless / "latest" read is NOT — so the display can be honest that no pinned
 * root was shown rather than printing a fabricated hex string.
 *
 * @param {string} s candidate root.
 * @returns {boolean} true iff `s` is exactly 64 hex chars.
 */
export function isHex64Root(s?: string | null): boolean {
  return /^[0-9a-f]{64}$/i.test(String(s || ""));
}

/**
 * The INCLUSION-PROOF detail for one resource (#134, mirrored from the browser).
 * Surfaces the proof ROOT (the capsule root the resource leaf was Merkle-proven
 * against) and a single 'verified against on-chain root' indicator. Progressive
 * disclosure lives in the UI (✓ by default, the root/path on expand); this is the
 * pure model behind it.
 *
 * Fail-closed: `verified` is true ONLY when the loader's per-resource verdict was
 * a positive pass (`inclusionProofPassed === true`). A passing entry without a
 * pinned 64-hex root still verified (against the resolved tip), but we mark
 * `hasRoot === false` and surface "latest" rather than print a root we don't
 * have. The verdict is the loader's — this never re-verifies.
 *
 * @param {object} e a ledger entry ({inclusionProofPassed, rootHash, storeId, errorCode}).
 * @returns {{verified:boolean, proofRoot:string, hasRoot:boolean,
 *   storeId:string, errorCode:string, label:string}}
 */
export function inclusionProofDisplay(e: Partial<LedgerEntry> | null | undefined) {
  const entry = e || {};
  const verified = entry.inclusionProofPassed === true;
  const root = String(entry.rootHash || "").toLowerCase();
  const hasRoot = isHex64Root(root);
  return {
    verified,
    // Show the concrete pinned root when we have one; otherwise be honest that
    // only the resolved tip ("latest") was used — never a fabricated hex string.
    proofRoot: hasRoot ? root : "latest",
    hasRoot,
    storeId: String(entry.storeId || "").toLowerCase(),
    errorCode: verified ? "" : String(entry.errorCode || ""),
    label: verified
      ? "Inclusion proof verified against on-chain root"
      : "Inclusion proof failed",
  };
}

/**
 * The EXECUTION-PROOF status for one served resource (#134, mirrored from the
 * browser) — the risc0 execution receipt from the SERVER that served the content
 * over RPC (dig.getProof / dig.getProofStatus `execution_proof_status`).
 *
 * HONESTY (the load-bearing rule): the live rpc.dig.net read path returns MOCK
 * execution proofs today (a known protocol gap), and the extension's read path
 * fetches dig.getContent (inclusion only) — so the loader has NO real execution
 * proof. This NEVER reports a mock/absent/pending proof as verified. `verified` is
 * true for exactly one state: a real terminal receipt. The default (no status
 * provided) is the honest "not provided / unknown".
 *
 * @param {object} e a ledger entry; reads `executionProofStatus` (the raw
 *   dig.getProof status string).
 * @returns {{verified:boolean, state:("verified"|"mock"|"pending"|"absent"|"unknown"),
 *   status:string, label:string}}
 */
export function executionProofDisplay(e: Partial<LedgerEntry> | null | undefined) {
  const entry = e || {};
  const status = String((entry && entry.executionProofStatus) || "").toLowerCase();
  // The honest mapping. The CRITICAL rule (rpc.dig.net returns MOCK execution
  // proofs today): ONLY a real terminal receipt is shown as verified; "mock" is
  // its OWN non-verified state so the UI can never green-check a forged receipt.
  if (status === "succeeded" || status === "verified") {
    return { verified: true, state: "verified", status,
      label: "Execution proof: verified" };
  }
  // A mock is its OWN state — surfaced honestly, NEVER as verified.
  if (status === "mock") {
    return { verified: false, state: "mock", status,
      label: "Execution proof: mock (not a real attestation)" };
  }
  if (status === "running" || status === "queued" || status === "request_via_control_plane") {
    return { verified: false, state: "pending", status,
      label: "Execution proof: requested — not yet available" };
  }
  if (status === "failed" || status === "not_found") {
    return { verified: false, state: "absent", status,
      label: "Execution proof: not provided" };
  }
  // No status at all: the honest default. The loader does not fetch execution
  // proofs yet, so this is what every resource currently shows.
  return { verified: false, state: "unknown", status: status || "none",
    label: "Execution proof: not provided" };
}
