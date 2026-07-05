import { describe, it, expect, vi } from 'vitest';
import { chromeBaseQuery } from '@/api/baseQuery';

const run = (arg: { action: string }) =>
  chromeBaseQuery(arg, {} as never, undefined as never) as Promise<{ data?: unknown; error?: unknown }>;

describe('chromeBaseQuery', () => {
  it('returns data for a plain reply', async () => {
    chrome.runtime.sendMessage = vi.fn((_m: unknown, cb?: (r: unknown) => void) => cb?.({ reachable: true })) as never;
    const res = await run({ action: 'getDigNodeStatus' });
    expect(res.data).toEqual({ reachable: true });
  });

  it('maps a success:false reply to a normalized error', async () => {
    chrome.runtime.sendMessage = vi.fn((_m: unknown, cb?: (r: unknown) => void) =>
      cb?.({ success: false, code: 'DIG_ERR_NETWORK', message: 'boom' }),
    ) as never;
    const res = await run({ action: 'proxyRequest' });
    expect(res.error).toEqual({ code: 'DIG_ERR_NETWORK', message: 'boom' });
  });

  it('maps a runtime lastError to a RUNTIME error', async () => {
    chrome.runtime.sendMessage = vi.fn((_m: unknown, cb?: (r: unknown) => void) => {
      chrome.runtime.lastError = { message: 'port closed' };
      cb?.(undefined);
      chrome.runtime.lastError = undefined;
    }) as never;
    const res = await run({ action: 'getVerification' });
    expect((res.error as { code: string }).code).toBe('RUNTIME');
  });
});
