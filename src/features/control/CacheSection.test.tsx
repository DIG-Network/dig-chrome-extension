import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { CacheSection } from '@/features/control/CacheSection';
import { renderWithProviders } from '@/test/harness';
import { ACTIONS } from '@/lib/messages';

/** Mock the SW seam per-action; record calls so mutations can be asserted. */
function mockCache(overrides: Record<string, unknown> = {}) {
  const calls: { action: string; [k: string]: unknown }[] = [];
  const responses: Record<string, unknown> = {
    [ACTIONS.cacheStats]: {
      cap_bytes: 100 * 1024 * 1024,
      used_bytes: 25 * 1024 * 1024,
      entry_count: 1,
      total_bytes: 1024,
      evicted_count: 0,
      evicted_bytes: 0,
      content_cache: { hits: 0, misses: 0 },
    },
    [ACTIONS.cacheList]: {
      cached: [{ capsule: 'aa:11', store_id: 'aa', root: '11', size_bytes: 1024, last_used_unix_ms: 1000, lru_rank: 0 }],
    },
    [ACTIONS.cacheSetCap]: { cap_bytes: 128 * 1024 * 1024 },
    [ACTIONS.cacheRemove]: { removed: true },
    [ACTIONS.cacheClear]: {},
    ...overrides,
  };
  chrome.runtime.sendMessage = vi.fn((msg: { action: string }, cb?: (r: unknown) => void) => {
    calls.push(msg as never);
    cb?.(responses[msg.action] ?? { success: true });
  }) as never;
  return { calls };
}

describe('CacheSection', () => {
  beforeEach(() => mockCache());

  it('shows the usage bar, telemetry, and the LRU-ordered cached entry', async () => {
    renderWithProviders(<CacheSection />);
    expect(await screen.findByTestId('control-cache-usage')).toHaveTextContent('25 MiB');
    expect(screen.getByTestId('control-cache-usage')).toHaveTextContent('100 MiB');
    expect(screen.getByTestId('control-cache-bar-fill')).toHaveStyle({ width: '25%' });
    expect(await screen.findByTestId('control-cache-entry')).toHaveTextContent('aa:11');
    expect(screen.getByTestId('control-cache-entry')).toHaveTextContent('#0');
  });

  it('validates the reserved-cap input and sends setCapBytes for a valid value', async () => {
    const { calls } = mockCache();
    renderWithProviders(<CacheSection />);
    const input = await screen.findByTestId('control-cache-cap-input');

    // Invalid → inline error, no RPC.
    fireEvent.change(input, { target: { value: '0' } });
    fireEvent.click(screen.getByTestId('control-cache-cap-apply'));
    expect(await screen.findByTestId('control-cache-cap-error')).toBeInTheDocument();

    // Valid → the setCap action fires.
    fireEvent.change(input, { target: { value: '128' } });
    fireEvent.click(screen.getByTestId('control-cache-cap-apply'));
    await waitFor(() => expect(calls.some((c) => c.action === ACTIONS.cacheSetCap && c.capBytes === 128 * 1024 * 1024)).toBe(true));
  });

  it('evicts a single entry and clears all', async () => {
    const { calls } = mockCache();
    renderWithProviders(<CacheSection />);
    fireEvent.click(await screen.findByTestId('control-cache-evict'));
    await waitFor(() => expect(calls.some((c) => c.action === ACTIONS.cacheRemove)).toBe(true));
    fireEvent.click(screen.getByTestId('control-cache-clear'));
    await waitFor(() => expect(calls.some((c) => c.action === ACTIONS.cacheClear)).toBe(true));
  });
});
