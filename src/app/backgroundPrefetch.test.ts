import { describe, it, expect, vi } from 'vitest';
import { prefetchContextKey, runPrefetchSequence } from '@/app/backgroundPrefetch';

describe('prefetchContextKey (#168)', () => {
  it('is stable for the same wallet id + index', () => {
    expect(prefetchContextKey({ walletId: 'w1', index: 0 })).toBe(prefetchContextKey({ walletId: 'w1', index: 0 }));
  });

  it('differs when the index changes (#165 single active index)', () => {
    expect(prefetchContextKey({ walletId: 'w1', index: 0 })).not.toBe(prefetchContextKey({ walletId: 'w1', index: 1 }));
  });

  it('differs when the wallet id changes (#162 wallet switch)', () => {
    expect(prefetchContextKey({ walletId: 'w1', index: 0 })).not.toBe(prefetchContextKey({ walletId: 'w2', index: 0 }));
  });

  it('handles a null wallet id distinctly from any real id', () => {
    expect(prefetchContextKey({ walletId: null, index: 0 })).not.toBe(prefetchContextKey({ walletId: 'null', index: 0 }));
  });
});

describe('runPrefetchSequence (#168 — cancellable, best-effort orchestration)', () => {
  it('runs every step in order when never superseded', async () => {
    const order: number[] = [];
    const steps = [
      () => { order.push(1); return Promise.resolve(); },
      () => { order.push(2); return Promise.resolve(); },
      () => { order.push(3); return Promise.resolve(); },
    ];
    await runPrefetchSequence(steps, () => true);
    expect(order).toEqual([1, 2, 3]);
  });

  it('never dispatches ANY step when already superseded before the first one', async () => {
    const step = vi.fn(() => Promise.resolve());
    await runPrefetchSequence([step, step], () => false);
    expect(step).not.toHaveBeenCalled();
  });

  it('stops issuing further steps the instant a later context supersedes this run (no coinset hammering)', async () => {
    let current = true;
    const order: number[] = [];
    const steps = [
      () => { order.push(1); current = false; return Promise.resolve(); }, // superseded mid-flight
      () => { order.push(2); return Promise.resolve(); },
      () => { order.push(3); return Promise.resolve(); },
    ];
    await runPrefetchSequence(steps, () => current);
    // Step 1 was already in flight when the switch happened, so it completes; steps 2/3 (not yet
    // started) must NEVER fire once superseded — this is the "cancels in-flight prefetch, starts
    // the new" contract from #168 (no stale/needless coinset calls for an old context).
    expect(order).toEqual([1]);
  });

  it('a rejected step does not abort the sequence (best-effort — a failed balance scan must not block collectibles/activity)', async () => {
    const order: string[] = [];
    const steps = [
      () => { order.push('balances'); return Promise.reject(new Error('offline')); },
      () => { order.push('assets'); return Promise.resolve(); },
      () => { order.push('collectibles'); return Promise.resolve(); },
      () => { order.push('activity'); return Promise.resolve(); },
    ];
    await expect(runPrefetchSequence(steps, () => true)).resolves.toBeUndefined();
    expect(order).toEqual(['balances', 'assets', 'collectibles', 'activity']);
  });

  it('a step that throws synchronously (not just a rejected promise) does not abort the sequence', async () => {
    const order: string[] = [];
    const steps = [
      () => {
        order.push('a');
        throw new Error('sync boom');
      },
      () => {
        order.push('b');
        return Promise.resolve();
      },
    ];
    await expect(runPrefetchSequence(steps, () => true)).resolves.toBeUndefined();
    expect(order).toEqual(['a', 'b']);
  });

  it('re-checks isCurrent before EVERY step, not just once at the start', async () => {
    const calls: boolean[] = [];
    let n = 0;
    const isCurrent = () => {
      const v = n < 2; // true for the first two checks, false after
      calls.push(v);
      return v;
    };
    const steps = [
      () => { n += 1; return Promise.resolve(); },
      () => { n += 1; return Promise.resolve(); },
      () => { n += 1; return Promise.resolve(); },
    ];
    await runPrefetchSequence(steps, isCurrent);
    // Checked before step 1 (true), before step 2 (true), before step 3 (false) — step 3 never runs.
    expect(calls).toEqual([true, true, false]);
    expect(n).toBe(2);
  });
});
