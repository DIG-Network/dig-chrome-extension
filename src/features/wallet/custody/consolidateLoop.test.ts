import { describe, it, expect, vi } from 'vitest';
import {
  runWithConsolidation,
  ConsolidationTimeoutError,
  type ConsolidateLoopDeps,
  type ConsolidationPhase,
} from './consolidateLoop';

/** A coded failure like the RTK baseQuery surfaces from the vault (`{ code, message }`). */
const coded = (code: string) => Object.assign(new Error(code), { code });
const isNeeds = (e: unknown) => !!e && typeof e === 'object' && (e as { code?: string }).code === 'NEEDS_CONSOLIDATION';
const quote = { asset: 'XCH', coinsMerged: 50, fee: '0' };

/** A deps factory with sensible defaults; override per test. */
function makeDeps(over: Partial<ConsolidateLoopDeps<string>>): ConsolidateLoopDeps<string> {
  return {
    attempt: vi.fn(async () => 'PREPARED'),
    isNeedsConsolidation: isNeeds,
    buildConsolidation: vi.fn(async () => ({ pendingId: 'pid', quote })),
    prompt: vi.fn(async () => true),
    confirm: vi.fn(async () => 'coin-1'),
    awaitConfirmation: vi.fn(async () => true),
    ...over,
  };
}

describe('runWithConsolidation (#417)', () => {
  it('returns the attempt value immediately when the spend is fundable', async () => {
    const deps = makeDeps({ attempt: vi.fn(async () => 'OK') });
    await expect(runWithConsolidation(deps)).resolves.toBe('OK');
    expect(deps.buildConsolidation).not.toHaveBeenCalled();
    expect(deps.prompt).not.toHaveBeenCalled();
  });

  it('consolidates → confirms → polls → RETRIES the spend, then succeeds', async () => {
    const attempt = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(coded('NEEDS_CONSOLIDATION')) // round 0: too fragmented
      .mockResolvedValueOnce('PREPARED'); // round 1: now selectable
    const phases: ConsolidationPhase[] = [];
    const deps = makeDeps({ attempt, onPhase: (p) => phases.push(p) });

    await expect(runWithConsolidation(deps)).resolves.toBe('PREPARED');
    expect(deps.buildConsolidation).toHaveBeenCalledOnce();
    expect(deps.prompt).toHaveBeenCalledWith(quote);
    expect(deps.confirm).toHaveBeenCalledWith('pid');
    expect(deps.awaitConfirmation).toHaveBeenCalledWith('coin-1');
    expect(attempt).toHaveBeenCalledTimes(2);
    // The modal is driven through the round then closed on success.
    expect(phases).toEqual(['consolidating', 'confirming', 'retrying', 'idle']);
  });

  it('re-throws the original signal when the user CANCELS the combine', async () => {
    const attempt = vi.fn(async () => {
      throw coded('NEEDS_CONSOLIDATION');
    });
    const deps = makeDeps({ attempt, prompt: vi.fn(async () => false) });
    await expect(runWithConsolidation(deps)).rejects.toMatchObject({ code: 'NEEDS_CONSOLIDATION' });
    expect(deps.confirm).not.toHaveBeenCalled();
    expect(attempt).toHaveBeenCalledOnce();
  });

  it('surfaces the original signal when nothing can be combined (build returns null)', async () => {
    const attempt = vi.fn(async () => {
      throw coded('NEEDS_CONSOLIDATION');
    });
    const deps = makeDeps({ attempt, buildConsolidation: vi.fn(async () => null) });
    await expect(runWithConsolidation(deps)).rejects.toMatchObject({ code: 'NEEDS_CONSOLIDATION' });
    expect(deps.prompt).not.toHaveBeenCalled();
  });

  it('passes a non-consolidation error straight through (e.g. INSUFFICIENT_FUNDS)', async () => {
    const attempt = vi.fn(async () => {
      throw coded('INSUFFICIENT_FUNDS');
    });
    const deps = makeDeps({ attempt });
    await expect(runWithConsolidation(deps)).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
    expect(deps.buildConsolidation).not.toHaveBeenCalled();
  });

  it('throws ConsolidationTimeoutError when the combine never confirms', async () => {
    const attempt = vi.fn(async () => {
      throw coded('NEEDS_CONSOLIDATION');
    });
    const deps = makeDeps({ attempt, awaitConfirmation: vi.fn(async () => false) });
    await expect(runWithConsolidation(deps)).rejects.toBeInstanceOf(ConsolidationTimeoutError);
  });

  it('gives up after maxRounds and surfaces the last signal (never loops forever)', async () => {
    const attempt = vi.fn(async () => {
      throw coded('NEEDS_CONSOLIDATION'); // always fragmented — pathological wallet
    });
    const deps = makeDeps({ attempt, maxRounds: 2 });
    await expect(runWithConsolidation(deps)).rejects.toMatchObject({ code: 'NEEDS_CONSOLIDATION' });
    // rounds 0 and 1 consolidate; round 2 hits the cap and throws → 3 attempts.
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(deps.confirm).toHaveBeenCalledTimes(2);
  });
});
