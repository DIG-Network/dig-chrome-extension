import { describe, it, expect, vi } from 'vitest';
import { mapWithConcurrency, withRetry, withTimeout } from './concurrency';

describe('withTimeout', () => {
  it('resolves when the promise settles in time', async () => {
    await expect(withTimeout(Promise.resolve(7), 1000)).resolves.toBe(7);
  });

  it('rejects with TIMEOUT when the promise hangs past ms', async () => {
    await expect(withTimeout(new Promise(() => {}), 20, 'chain read')).rejects.toThrow(/TIMEOUT: chain read/);
  });

  it('propagates a rejection unchanged', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 1000)).rejects.toThrow('boom');
  });

  it('disables the timeout for ms <= 0 (returns the promise as-is)', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 0)).resolves.toBe('ok');
  });
});

describe('mapWithConcurrency', () => {
  it('maps every item preserving input order', async () => {
    const out = await mapWithConcurrency([1, 2, 3, 4], 2, async (n) => n * 10);
    expect(out).toEqual([10, 20, 30, 40]);
  });

  it('never exceeds the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 12 }, (_, i) => i);
    await mapWithConcurrency(items, 4, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return n;
    });
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1); // actually ran in parallel
  });

  it('treats a non-positive limit as serial (1)', async () => {
    let peak = 0;
    let inFlight = 0;
    await mapWithConcurrency([1, 2, 3], 0, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      return n;
    });
    expect(peak).toBe(1);
  });

  it('returns an empty array for no items', async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
  });

  it('propagates a rejection from fn', async () => {
    await expect(mapWithConcurrency([1, 2], 2, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
  });
});

describe('withRetry', () => {
  it('returns the value on first success without sleeping', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const v = await withRetry(async () => 42, { retries: 3, sleep });
    expect(v).toBe(42);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries a transient failure then succeeds (exponential backoff)', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    let calls = 0;
    const v = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new Error('flaky');
        return 'ok';
      },
      { retries: 3, baseDelayMs: 100, sleep },
    );
    expect(v).toBe('ok');
    expect(calls).toBe(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([100, 200]); // 100*2^0, 100*2^1
  });

  it('rethrows the last error once attempts are exhausted', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    let calls = 0;
    await expect(
      withRetry(async () => { calls++; throw new Error(`fail-${calls}`); }, { retries: 2, sleep }),
    ).rejects.toThrow('fail-3');
    expect(calls).toBe(3); // 1 + 2 retries
  });

  it('retries: 0 means a single attempt', async () => {
    let calls = 0;
    await expect(withRetry(async () => { calls++; throw new Error('x'); }, { retries: 0 })).rejects.toThrow('x');
    expect(calls).toBe(1);
  });
});
