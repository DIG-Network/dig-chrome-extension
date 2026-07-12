import { describe, it, expect, vi, afterEach } from 'vitest';
import { copyText } from '@/lib/clipboard';

afterEach(() => vi.restoreAllMocks());

describe('copyText', () => {
  it('writes to navigator.clipboard and returns true on success', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    await expect(copyText('hello')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
  });

  it('returns false when the write is rejected (denied / insecure context)', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
    await expect(copyText('x')).resolves.toBe(false);
  });

  it('returns false when the Clipboard API is unavailable', async () => {
    vi.stubGlobal('navigator', {});
    await expect(copyText('x')).resolves.toBe(false);
  });
});
