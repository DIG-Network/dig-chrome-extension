/**
 * The auto-consolidate LOOP (#417) — the pure orchestration that makes EVERY self-custody send/spend
 * succeed on a coin-fragmented wallet. It wraps a spend `attempt` (the RTK `prepareSend`); when the
 * attempt fails because the wallet holds too many small coins (the vault's `NEEDS_CONSOLIDATION`
 * code), it:
 *   1. builds an honest keyless combine (the vault's `prepareConsolidation` — no broadcast yet) to
 *      compute the quote,
 *   2. asks the user with a dismissible modal (NO dark pattern — §6.0/#207),
 *   3. on YES, broadcasts the combine (`confirmSend`) + WAITS for on-chain confirmation,
 *   4. re-attempts the original spend (now backed by fewer, larger coins),
 *   5. loops until the attempt succeeds or the user cancels.
 *
 * Everything with a side effect is INJECTED (`ConsolidateLoopDeps`) so the loop is a pure, framework-
 * free unit that unit-tests without a wallet, chain, or RTK store. `useConsolidatingSend.ts` wires the
 * real mutations (`prepareSend` / `prepareConsolidation` / `confirmSend` / `sendStatus`) + the modal.
 * Mirrors the hub #416 reference (`features/coin-management/consolidate.ts`).
 */

/** The loop's current step, surfaced to the modal (idle closes it). */
export type ConsolidationPhase = 'idle' | 'prompting' | 'consolidating' | 'confirming' | 'retrying';

/** The honest, user-facing quote for one combine round (from the vault's decoded coin-op summary). */
export interface ConsolidateQuote {
  /** `'XCH'` or the CAT TAIL hex — which asset is being consolidated. */
  asset: string;
  /** How many coins this round merges into one. */
  coinsMerged: number;
  /** The XCH network fee for the combine (base-unit mojos, decimal string). */
  fee: string;
}

/** A built (unsigned, un-broadcast) consolidation: the pending id to confirm + the quote to show. */
export interface BuiltConsolidation {
  pendingId: string;
  quote: ConsolidateQuote;
}

/** The side effects the loop drives — all injected so the loop stays pure + testable. */
export interface ConsolidateLoopDeps<T> {
  /** Attempt the spend (`prepareSend`). Resolves the prepared value on success; rejects with a
   *  coded error (carrying `.code`) on failure. */
  attempt: () => Promise<T>;
  /** True iff `err` is the recoverable NEEDS_CONSOLIDATION signal (drives the combine modal). */
  isNeedsConsolidation: (err: unknown) => boolean;
  /** Build the combine (`prepareConsolidation`) — no broadcast. Resolves the pending id + quote, or
   *  `null` when nothing can be combined (surface the original error honestly). */
  buildConsolidation: () => Promise<BuiltConsolidation | null>;
  /** Ask the user (honest, dismissible modal). Resolves true to combine, false to cancel. */
  prompt: (quote: ConsolidateQuote) => Promise<boolean>;
  /** Sign + BROADCAST the built combine (`confirmSend`). Resolves the spent coin id to poll. */
  confirm: (pendingId: string) => Promise<string>;
  /** Wait for the combine to confirm on-chain (poll `sendStatus`). Resolves true when confirmed. */
  awaitConfirmation: (coinId: string) => Promise<boolean>;
  /** Report the loop phase (drives the modal). */
  onPhase?: (phase: ConsolidationPhase) => void;
  /** Safety cap on combine rounds (a pathological wallet can't loop forever). Default 8. */
  maxRounds?: number;
}

/** Thrown when a broadcast combine never reaches confirmation within the poll window. */
export class ConsolidationTimeoutError extends Error {
  constructor() {
    super('CONSOLIDATION_TIMEOUT: the combine transaction did not confirm in time; try again.');
    this.name = 'ConsolidationTimeoutError';
  }
}

/**
 * Run `attempt`, transparently consolidating + retrying on a NEEDS_CONSOLIDATION failure. Returns
 * `attempt`'s value on success. Re-throws any non-consolidation error, the original signal on user
 * cancel or when nothing can be combined, and {@link ConsolidationTimeoutError} on a stuck combine.
 */
export async function runWithConsolidation<T>(deps: ConsolidateLoopDeps<T>): Promise<T> {
  const maxRounds = deps.maxRounds ?? 8;
  const done = () => deps.onPhase?.('idle');

  for (let round = 0; ; round++) {
    try {
      const value = await deps.attempt();
      done();
      return value;
    } catch (err) {
      // Only the "too many small coins" signal is recoverable here; everything else surfaces.
      if (!deps.isNeedsConsolidation(err) || round >= maxRounds) {
        done();
        throw err;
      }

      const built = await deps.buildConsolidation();
      // Nothing combinable (e.g. every coin sits alone) → can't help; surface the original signal.
      if (!built) {
        done();
        throw err;
      }

      // Honest consent (dismissible). Cancel → surface the original signal.
      const proceed = await deps.prompt(built.quote);
      if (!proceed) {
        done();
        throw err;
      }

      deps.onPhase?.('consolidating');
      const coinId = await deps.confirm(built.pendingId);
      deps.onPhase?.('confirming');
      const confirmed = await deps.awaitConfirmation(coinId);
      if (!confirmed) {
        done();
        throw new ConsolidationTimeoutError();
      }
      deps.onPhase?.('retrying');
      // loop → re-attempt the original spend, now backed by fewer, larger coins.
    }
  }
}
