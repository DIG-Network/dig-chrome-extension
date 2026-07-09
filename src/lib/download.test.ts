import { describe, it, expect, vi } from 'vitest';
import { downloadTextFile } from '@/lib/download';

describe('downloadTextFile (#115 keystore backup export)', () => {
  it('creates a blob URL, clicks an <a download> with the filename, and revokes the URL', () => {
    const createObjectURL = vi.fn(() => 'blob:fake');
    const revokeObjectURL = vi.fn();
    let clicked: HTMLAnchorElement | null = null;
    const click = vi.fn((a: HTMLAnchorElement) => { clicked = a; });

    vi.useFakeTimers();
    downloadTextFile('dig-wallet-main-2026-07-08.json', '{"magic":"DIGWBK1"}', 'application/json', {
      createObjectURL,
      revokeObjectURL,
      click,
    });

    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    expect(clicked!.download).toBe('dig-wallet-main-2026-07-08.json');
    expect(clicked!.href).toContain('blob:fake');
    // The synthetic anchor is removed from the DOM after clicking (no leftover node).
    expect(document.querySelector('a[download]')).toBeNull();

    // URL is revoked on the next tick (after the browser has had a chance to start the download).
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:fake');
    vi.useRealTimers();
  });
});
