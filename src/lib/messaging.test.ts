import { describe, it, expect, vi } from 'vitest';
import { hasRuntime, sendAction, storageGet, storageSet } from '@/lib/messaging';

describe('messaging', () => {
  it('detects the runtime', () => {
    expect(hasRuntime()).toBe(true);
  });

  it('resolves a sendMessage reply', async () => {
    chrome.runtime.sendMessage = vi.fn((_m: unknown, cb?: (r: unknown) => void) => cb?.({ ok: 1 })) as never;
    expect(await sendAction({ action: 'x' })).toEqual({ ok: 1 });
  });

  it('rejects when lastError is set', async () => {
    chrome.runtime.sendMessage = vi.fn((_m: unknown, cb?: (r: unknown) => void) => {
      chrome.runtime.lastError = { message: 'nope' };
      cb?.(undefined);
      chrome.runtime.lastError = undefined;
    }) as never;
    await expect(sendAction({ action: 'x' })).rejects.toThrow('nope');
  });

  it('reads and writes storage', async () => {
    await storageSet({ 'test.key': 42 });
    expect(await storageGet<{ 'test.key': number }>('test.key')).toEqual({ 'test.key': 42 });
  });
});
