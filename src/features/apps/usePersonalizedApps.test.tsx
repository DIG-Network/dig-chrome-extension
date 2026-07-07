import { describe, it, expect, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { usePersonalizedApps } from '@/features/apps/usePersonalizedApps';
import { APPS_PERSONALIZATION_KEY } from '@/features/apps/personalization';
import type { StoreApp } from '@/features/apps/storeCatalog';

const app = (slug: string): StoreApp => ({
  slug,
  name: slug,
  icon: `https://explore.dig.net/catalog/${slug}/icon.png`,
  link: `https://${slug}.on.dig.net/`,
  category: 'tools',
  featured: false,
});

const CATALOG = [app('a'), app('b'), app('c')];

beforeEach(async () => {
  await chrome.storage.local.remove(APPS_PERSONALIZATION_KEY);
});

describe('usePersonalizedApps', () => {
  it('starts in catalog order with nothing hidden, and becomes ready', async () => {
    const { result } = renderHook(() => usePersonalizedApps(CATALOG));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.visible.map((a) => a.slug)).toEqual(['a', 'b', 'c']);
    expect(result.current.hiddenApps).toEqual([]);
  });

  it('reorder() persists the new order across a re-render (simulating popup reopen)', async () => {
    const { result, rerender } = renderHook(() => usePersonalizedApps(CATALOG));
    await waitFor(() => expect(result.current.ready).toBe(true));

    act(() => {
      result.current.reorder(2, 0); // move 'c' to the front
    });
    await waitFor(() => expect(result.current.visible.map((a) => a.slug)).toEqual(['c', 'a', 'b']));

    // A fresh mount (as if the popup were reopened) re-reads the same persisted key.
    const mountedAgain = renderHook(() => usePersonalizedApps(CATALOG));
    await waitFor(() => expect(mountedAgain.result.current.ready).toBe(true));
    expect(mountedAgain.result.current.visible.map((a) => a.slug)).toEqual(['c', 'a', 'b']);
    rerender();
  });

  it('moveApp() reorders one slot via keyboard-style up/down', async () => {
    const { result } = renderHook(() => usePersonalizedApps(CATALOG));
    await waitFor(() => expect(result.current.ready).toBe(true));

    act(() => {
      result.current.moveApp('c', 'up');
    });
    await waitFor(() => expect(result.current.visible.map((a) => a.slug)).toEqual(['a', 'c', 'b']));
  });

  it('hideApp() moves an app to hiddenApps; showApp() restores it to the grid', async () => {
    const { result } = renderHook(() => usePersonalizedApps(CATALOG));
    await waitFor(() => expect(result.current.ready).toBe(true));

    act(() => {
      result.current.hideApp('b');
    });
    await waitFor(() => expect(result.current.visible.map((a) => a.slug)).toEqual(['a', 'c']));
    expect(result.current.hiddenApps.map((a) => a.slug)).toEqual(['b']);

    act(() => {
      result.current.showApp('b');
    });
    await waitFor(() => expect(result.current.hiddenApps).toEqual([]));
    // No custom order was ever set, so unhiding restores 'b' to its original catalog position.
    expect(result.current.visible.map((a) => a.slug)).toEqual(['a', 'b', 'c']);
  });

  it('reconciles gracefully when the catalog changes underneath the saved prefs', async () => {
    const { result, rerender } = renderHook(({ apps }: { apps: StoreApp[] }) => usePersonalizedApps(apps), {
      initialProps: { apps: CATALOG },
    });
    await waitFor(() => expect(result.current.ready).toBe(true));
    act(() => {
      result.current.hideApp('b');
    });
    await waitFor(() => expect(result.current.hiddenApps.map((a) => a.slug)).toEqual(['b']));

    // 'b' is removed from the catalog server-side; a new app 'd' appears.
    const nextCatalog = [app('a'), app('c'), app('d')];
    rerender({ apps: nextCatalog });

    await waitFor(() => expect(result.current.visible.map((a) => a.slug)).toEqual(['a', 'c', 'd']));
    expect(result.current.hiddenApps).toEqual([]); // 'b' is gone, not a ghost hidden entry
  });
});
