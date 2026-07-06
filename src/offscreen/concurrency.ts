/**
 * Bounded-concurrency + retry helpers for the coinset read fan-out (§18 discovery). coinset.org
 * returns "error decoding response body" under heavy parallelism and is intermittently flaky, so
 * every multi-coin scan (CAT discovery, NFT discovery) MUST cap in-flight requests (~4) and retry a
 * transient failure with backoff. Pure (no chrome.* / DOM / timers beyond an injectable sleep), so
 * both helpers are unit-tested with fakes.
 */

/** A no-op-friendly async sleep; injectable so tests run without real timers. */
export type Sleep = (ms: number) => Promise<void>;

const defaultSleep: Sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/**
 * Map `items` through `fn` with at most `limit` calls in flight at once, preserving input order in
 * the result. A `limit <= 0` is treated as 1 (fully serial). Rejections propagate (wrap `fn` in
 * {@link withRetry} for flaky sources).
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const bound = Math.max(1, Math.floor(limit) || 1);
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(bound, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Reject with a `TIMEOUT` error if `promise` does not settle within `ms`. Guards against a chain read
 * that never settles (a dead/blocked endpoint — the wasm coinset `RpcClient` has NO built-in timeout,
 * so without this a scan hangs the wallet forever instead of falling back to the cached snapshot).
 * `ms <= 0` disables the timeout (returns the promise unchanged). The timer is always cleared.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label = 'request'): Promise<T> {
  if (!(ms > 0)) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`TIMEOUT: ${label} exceeded ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Run `fn`, retrying on rejection up to `retries` extra attempts with exponential backoff
 * (`baseDelayMs * 2^attempt`). The LAST error is rethrown once attempts are exhausted. `retries: 0`
 * means a single attempt (no retry). Backoff sleep is injectable for tests.
 */
export async function withRetry<R>(
  fn: () => Promise<R>,
  opts: { retries?: number; baseDelayMs?: number; sleep?: Sleep } = {},
): Promise<R> {
  const retries = Math.max(0, Math.floor(opts.retries ?? 2));
  const baseDelayMs = opts.baseDelayMs ?? 150;
  const sleep = opts.sleep ?? defaultSleep;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await sleep(baseDelayMs * 2 ** attempt);
    }
  }
  throw lastErr;
}
