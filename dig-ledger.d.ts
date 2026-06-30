// Type declarations for dig-ledger.mjs — the DIG Shields per-resource inclusion-proof ledger
// (#134). BYTE-MIRROR of the native DIG Browser's dig/shields/dig_ledger.mjs; keep in lockstep.

/** The default view's resource key (an empty / "/" path resolves to index.html). */
export const DEFAULT_RESOURCE_KEY: string;

/** Per-capsule entry cap (bounds memory; most recent kept). */
export const DEFAULT_MAX_ENTRIES: number;

/** The canonical capsule key — `storeId:rootHash`, lowercased (rootless → `<storeId>:latest`). */
export function capsuleKey(storeId: string, rootHash: string): string;

/** Is `s` a 64-hex capsule/proof root? */
export function isHex64Root(s: string): boolean;

/** One recorded per-resource proof verdict. */
export interface LedgerEntry {
  resourcePath: string;
  storeId: string;
  rootHash: string;
  inclusionProofPassed: boolean;
  errorCode: string;
  executionProofStatus: string;
}

/** A per-tab/per-capsule accumulator of inclusion-proof verdicts. */
export class LedgerStore {
  constructor(opts?: { maxEntries?: number });
  record(e: {
    storeId: string;
    rootHash: string;
    resourcePath: string;
    inclusionProofPassed: boolean;
    errorCode?: string;
    executionProofStatus?: string;
  }): void;
  entriesFor(storeId: string, rootHash: string): LedgerEntry[];
}

/** Group a capsule's ledger entries into PASSED vs FAILED with counts + derived states. */
export function groupLedger(entries: LedgerEntry[] | null | undefined): {
  passed: LedgerEntry[];
  failed: LedgerEntry[];
  passedCount: number;
  failedCount: number;
  total: number;
  allPassed: boolean;
  empty: boolean;
};

/** The per-resource INCLUSION-PROOF display model (#134). */
export function inclusionProofDisplay(e: Partial<LedgerEntry>): {
  verified: boolean;
  proofRoot: string;
  hasRoot: boolean;
  storeId: string;
  errorCode: string;
  label: string;
};

/** The per-resource EXECUTION-PROOF display model (#134) — honest about mock/absent/pending. */
export function executionProofDisplay(e: Partial<LedgerEntry>): {
  verified: boolean;
  state: 'verified' | 'mock' | 'pending' | 'absent' | 'unknown';
  status: string;
  label: string;
};
