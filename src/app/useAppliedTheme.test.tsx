import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { Provider } from 'react-redux';
import { act, renderHook } from '@testing-library/react';
import { createStore, type AppStore } from '@/app/store';
import { setTheme } from '@/features/ui/uiSlice';
import { useAppliedTheme } from '@/app/useAppliedTheme';

function wrapper(store: AppStore) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <Provider store={store}>{children}</Provider>;
  };
}

/** A minimal `MediaQueryList` stub whose `matches` + change-listener the test controls directly. */
function stubMatchMedia(initialMatches: boolean) {
  let matches = initialMatches;
  const listeners = new Set<() => void>();
  const mql = {
    get matches() {
      return matches;
    },
    media: '(prefers-color-scheme: dark)',
    addEventListener: (_type: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_type: string, fn: () => void) => listeners.delete(fn),
  };
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue(mql));
  return {
    setMatches(next: boolean) {
      matches = next;
      listeners.forEach((fn) => fn());
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.digTheme;
});

describe('useAppliedTheme (#111)', () => {
  it('applies an explicit light/dark mode to documentElement.dataset.digTheme', () => {
    stubMatchMedia(false);
    const store = createStore();
    store.dispatch(setTheme('dark'));
    renderHook(() => useAppliedTheme(), { wrapper: wrapper(store) });
    expect(document.documentElement.dataset.digTheme).toBe('dark');

    act(() => {
      store.dispatch(setTheme('light'));
    });
    renderHook(() => useAppliedTheme(), { wrapper: wrapper(store) });
    expect(document.documentElement.dataset.digTheme).toBe('light');
  });

  it('"system" follows the OS prefers-color-scheme signal, live', () => {
    const media = stubMatchMedia(false);
    const store = createStore();
    store.dispatch(setTheme('system'));
    renderHook(() => useAppliedTheme(), { wrapper: wrapper(store) });
    expect(document.documentElement.dataset.digTheme).toBe('light');

    media.setMatches(true);
    expect(document.documentElement.dataset.digTheme).toBe('dark');
  });

  it('degrades gracefully when matchMedia is unavailable (treats as light)', () => {
    vi.stubGlobal('matchMedia', undefined);
    const store = createStore();
    store.dispatch(setTheme('system'));
    expect(() => renderHook(() => useAppliedTheme(), { wrapper: wrapper(store) })).not.toThrow();
    expect(document.documentElement.dataset.digTheme).toBe('light');
  });
});
