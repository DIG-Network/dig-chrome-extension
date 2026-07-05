import { describe, it, expect, vi } from 'vitest';
import { popOutToFullpage } from '@/lib/popout';

describe('popOutToFullpage', () => {
  it('focuses an existing app.html tab (singleton) instead of duplicating', async () => {
    chrome.tabs.query = vi.fn(async () => [{ id: 7 }]) as never;
    const update = vi.fn(async () => ({}));
    const create = vi.fn(async () => ({ id: 9 }));
    chrome.tabs.update = update as never;
    chrome.tabs.create = create as never;
    await popOutToFullpage('#wallet/activity', false);
    expect(update).toHaveBeenCalledWith(7, { active: true });
    expect(create).not.toHaveBeenCalled();
  });

  it('creates a new app.html tab when none exists', async () => {
    chrome.tabs.query = vi.fn(async () => []) as never;
    const create = vi.fn(async () => ({ id: 9 }));
    chrome.tabs.create = create as never;
    await popOutToFullpage('#apps', false);
    expect(create).toHaveBeenCalledWith({ url: 'chrome-extension://test-extension/app.html#apps' });
  });
});
