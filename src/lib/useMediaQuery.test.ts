import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useMediaQuery } from '@/lib/useMediaQuery';

const original = window.matchMedia;
afterEach(() => {
  window.matchMedia = original;
});

function mockMatchMedia(matches: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

describe('useMediaQuery', () => {
  it('returns false when matchMedia is unavailable', () => {
    // jsdom has no matchMedia by default.
    (window as unknown as { matchMedia?: unknown }).matchMedia = undefined;
    const { result } = renderHook(() => useMediaQuery('(min-width: 960px)'));
    expect(result.current).toBe(false);
  });

  it('reflects a matching query', () => {
    mockMatchMedia(true);
    const { result } = renderHook(() => useMediaQuery('(min-width: 960px)'));
    expect(result.current).toBe(true);
  });
});
