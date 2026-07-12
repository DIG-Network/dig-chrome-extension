/**
 * One-time GUIDED seed migration (#374, dig-node SPEC §18.20 import path) — the safety-critical
 * orchestration that moves the extension's existing self-custody seed INTO the node ONCE, then
 * purges the local key material. This is the pivot of the thin-client cutover (epic #365): after it,
 * the extension holds NO key material and the node is the sole custodian + signer.
 *
 * # HARD safety rules (task #374 — non-negotiable, encoded here)
 * 1. **Verify before purge.** Local key material is purged ONLY after (a) the node confirms it holds
 *    the seed (`wallet.import` returned an address) AND (b) a round-trip proves the node can SIGN on
 *    this caller's behalf — the node's UNLOCKED custody status reports the SAME receive address the
 *    extension derives from the very seed it sent (the fingerprint match, {@link nodeProvesCanSign}).
 *    A mismatch or a not-unlocked node ABORTS with the seed still local (nothing is lost).
 * 2. **Idempotent.** Re-running never double-imports: the node is imported into ONLY when it has no
 *    seed (`status.state === 'none'`); if it already holds the migrated seed we skip straight to
 *    verify. Safe to call on every unlock.
 * 3. **Resumable.** A crash at ANY point leaves the seed local and the node either without the seed
 *    (→ re-import) or with it (→ re-verify then purge). Because the purge is the LAST step and is
 *    gated on the live verify, an interrupted run simply re-enters and finishes; the seed cannot be
 *    lost mid-migration.
 * 4. **Never purge unverified.** The ONLY path to {@link MigrationDeps.purgeLocal} is through a
 *    passing verify. There is no other caller.
 *
 * PURE: every side effect (reading the local seed, the node ops, the purge) is injected, so the whole
 * gate — including the crash-mid-migration path — is exhaustively unit-tested with no chrome-api/DOM.
 */

import type { NodeCustodyStatus } from './node-custody';
import type { WalletEntry } from './wallet-registry';

/** The outcome of a migration run (for the UI + logging; none of these leak key material). */
export type MigrationOutcome =
  /** The seed was imported to the node, verified, and purged locally — the wallet is now node-custody. */
  | 'migrated'
  /** The node already held the migrated seed (verified); local material was purged (or already gone). */
  | 'already-on-node'
  /** No local seed to migrate and the node has none either — a fresh node-custody user; nothing to do. */
  | 'nothing-to-migrate';

/** A failed migration: the seed is STILL LOCAL (never purged), with a reason for the UI. */
export class MigrationAbortedError extends Error {
  constructor(
    message: string,
    /** A stable symbolic reason the UI branches on (never message prose). */
    readonly reason: 'verify-failed' | 'import-failed' | 'node-unreachable' | 'seed-unavailable',
  ) {
    super(message);
    this.name = 'MigrationAbortedError';
  }
}

/** The extension's local seed for migration: the decrypted mnemonic + the address IT derives from it. */
export interface LocalSeedForMigration {
  /**
   * The registry id of the wallet being migrated. The purge is SCOPED to exactly this id (safety rule
   * 1) — never the whole registry — so a multi-wallet user's OTHER wallets are never destroyed.
   */
  walletId: string;
  /** The BIP-39 mnemonic decrypted from the local DIGWX1 keystore (transient — sent once, then purged). */
  mnemonic: string;
  /**
   * The `xch1…` index-0 receive address the EXTENSION derives from this same mnemonic. The migration
   * gate compares it to the node's unlocked address: an exact match proves the node loaded the
   * identical key and can sign for this wallet (the fingerprint round-trip, safety rule 1b).
   */
  expectedAddress: string;
}

/** The injected effects the migration orchestrates (all side effects live here, so the core is pure). */
export interface MigrationDeps {
  /**
   * Decrypt the local seed with `password` and derive its index-0 receive address. Resolves `null`
   * when there is NO local key material (already purged / a fresh node-custody install). Rejects on a
   * wrong password (surfaced as `seed-unavailable`), so a bad password never proceeds to a purge.
   */
  getLocalSeed: (password: string) => Promise<LocalSeedForMigration | null>;
  /** Read the node's current custody status (`wallet.status`). */
  nodeStatus: () => Promise<NodeCustodyStatus>;
  /** Send the mnemonic to the node ONCE (`wallet.import` — the only inbound key path, §18.20). */
  nodeImport: (mnemonic: string, password: string) => Promise<{ address: string }>;
  /**
   * Ensure the node's seed is UNLOCKED so its status reports the receive address for the verify gate.
   * Called only when the node already holds a seed but is `locked`; a no-op path when already unlocked.
   */
  nodeUnlock: (password: string) => Promise<{ address: string }>;
  /**
   * PURGE ONLY the given wallet's key material — its entry (encrypted record) is removed from the
   * registry and the mirror/active-id are recomputed over what remains (see `node-purge.ts`
   * `purgeWalletFromRegistry`). Every OTHER wallet stays locally intact. Called ONLY after a passing
   * verify for THIS `walletId` (safety rules 1 + 4). Idempotent (removing an absent id is a no-op).
   */
  purgeWallet: (walletId: string) => Promise<void>;
}

/**
 * The verify gate (safety rule 1b): the node can sign on this caller's behalf IFF its custody status
 * is UNLOCKED and reports the SAME receive address the extension derived from the seed it sent. An
 * address mismatch means the node loaded a DIFFERENT key — the migration MUST abort with the seed
 * still local. Pure + exported so the gate itself is unit-tested.
 */
export function nodeProvesCanSign(status: NodeCustodyStatus, expected: LocalSeedForMigration): boolean {
  return status.state === 'unlocked' && !!status.address && status.address === expected.expectedAddress;
}

/**
 * Run the one-time guided seed migration under `password` (the same password the user just used to
 * unlock locally — the node encrypts the imported seed under it). Returns the {@link MigrationOutcome}
 * on success; throws {@link MigrationAbortedError} (seed still local) on any failure.
 *
 * Flow (each step re-derived from the live node status, so a re-run after a crash resumes safely):
 *  1. Read the local seed for the target wallet. If none → NEVER purge (no verify is possible): the
 *     node having a seed → `already-on-node` (this wallet's record is already gone); none →
 *     `nothing-to-migrate`.
 *  2. If the node has NO seed → `wallet.import` the local mnemonic (idempotency rule 2: import only
 *     from `none`).
 *  3. If the node has a seed but is `locked` → `wallet.unlock` so its status can report the address.
 *  4. VERIFY: the node is unlocked AND its address matches the expected local address (rule 1).
 *     On failure → abort, seed still local.
 *  5. Only now → `purgeWallet(local.walletId)` (rules 1 + 4) — scoped to THIS wallet, never the whole
 *     registry. Return `migrated` (imported this run) or `already-on-node`.
 */
export async function runSeedMigration(password: string, deps: MigrationDeps): Promise<MigrationOutcome> {
  let status: NodeCustodyStatus;
  try {
    status = await deps.nodeStatus();
  } catch (e) {
    throw new MigrationAbortedError(`node unreachable: ${errMsg(e)}`, 'node-unreachable');
  }

  const local = await deps.getLocalSeed(password).catch((e) => {
    throw new MigrationAbortedError(`local seed unavailable: ${errMsg(e)}`, 'seed-unavailable');
  });

  // No local key material for the target wallet — nothing of THIS wallet to purge. NEVER purge here:
  // without a local seed there is no `nodeProvesCanSign` check possible, and purging unverified could
  // destroy another wallet's record (the fund-loss bug). Just classify: the node holding a seed means
  // this wallet's record is already gone (a prior run purged it); the node having none means there was
  // nothing to migrate.
  if (!local) {
    return status.state === 'none' ? 'nothing-to-migrate' : 'already-on-node';
  }

  const importedThisRun = status.state === 'none';
  if (importedThisRun) {
    // Idempotency rule 2: import ONLY from `none`, so a re-run never double-imports.
    try {
      await deps.nodeImport(local.mnemonic, password);
    } catch (e) {
      throw new MigrationAbortedError(`node import failed: ${errMsg(e)}`, 'import-failed');
    }
    status = await deps.nodeStatus().catch((e) => {
      throw new MigrationAbortedError(`node unreachable after import: ${errMsg(e)}`, 'node-unreachable');
    });
  } else if (status.state === 'locked') {
    // The node already holds a seed (a prior run imported it, then crashed before purge). Unlock so
    // its status can report the address for the verify gate — never re-import.
    try {
      await deps.nodeUnlock(password);
    } catch (e) {
      throw new MigrationAbortedError(`node unlock failed: ${errMsg(e)}`, 'verify-failed');
    }
    status = await deps.nodeStatus().catch((e) => {
      throw new MigrationAbortedError(`node unreachable after unlock: ${errMsg(e)}`, 'node-unreachable');
    });
  }

  // VERIFY (safety rule 1): the node must be unlocked AND prove it holds the SAME key (address match).
  if (!nodeProvesCanSign(status, local)) {
    throw new MigrationAbortedError(
      'the node did not prove it can sign for this wallet (address mismatch or not unlocked); local key material was NOT purged',
      'verify-failed',
    );
  }

  // Only after a passing verify (safety rule 4), and SCOPED to exactly this wallet (safety rule 1) —
  // never the whole registry, so a multi-wallet user's other seeds are never touched.
  await deps.purgeWallet(local.walletId);
  return importedThisRun ? 'migrated' : 'already-on-node';
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Why a multi-wallet cutover cannot complete yet (recorded as the flip blocker). */
export type CutoverBlockReason = 'multi-wallet-needs-node-custody';

/** The cutover eligibility verdict for the current registry. */
export interface CutoverEligibility {
  /** True when the flip may proceed (0 or 1 custody wallet). */
  eligible: boolean;
  /** How many wallets hold an encrypted record (each needs node custody to be migrated). */
  custodyWalletCount: number;
  /** The blocker when not eligible. */
  reason?: CutoverBlockReason;
}

/**
 * Decide whether the thin-client flip may complete for `wallets`. Node custody is currently
 * SINGLE-wallet (dig-node #370: one seed / one `wallet.status`), so the cutover can fully migrate at
 * most ONE custody wallet. With >1 wallet holding a `record`, the flip is REFUSED
 * (`multi-wallet-needs-node-custody`) rather than over-purging — the extra seeds stay local and the
 * blocker is recorded (a #370 node-side multi-wallet-custody follow-up unblocks it). Watch-only
 * entries hold no secret and do not count toward the limit.
 */
export function cutoverEligibility(wallets: readonly WalletEntry[]): CutoverEligibility {
  const custodyWalletCount = wallets.filter((w) => !!w.record).length;
  if (custodyWalletCount > 1) {
    return { eligible: false, custodyWalletCount, reason: 'multi-wallet-needs-node-custody' };
  }
  return { eligible: true, custodyWalletCount };
}
