import { describe, it, expect } from 'vitest';
import {
  parsePersonalization,
  applyPersonalization,
  moveByIndex,
  reorderState,
  moveAppState,
  hideAppState,
  showAppState,
  DEFAULT_PERSONALIZATION,
} from '@/features/apps/personalization';
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

describe('parsePersonalization', () => {
  it('defaults to empty order/hidden for junk or missing input', () => {
    expect(parsePersonalization(undefined)).toEqual(DEFAULT_PERSONALIZATION);
    expect(parsePersonalization(null)).toEqual(DEFAULT_PERSONALIZATION);
    expect(parsePersonalization('not an object')).toEqual(DEFAULT_PERSONALIZATION);
    expect(parsePersonalization({})).toEqual({ order: [], hidden: [] });
  });

  it('keeps only string entries from order/hidden arrays', () => {
    expect(parsePersonalization({ order: ['a', 1, null, 'b'], hidden: ['c', {}] })).toEqual({
      order: ['a', 'b'],
      hidden: ['c'],
    });
  });
});

describe('applyPersonalization', () => {
  it('with no personalization, returns the catalog in its own order, nothing hidden', () => {
    const { visible, hiddenApps } = applyPersonalization(CATALOG, DEFAULT_PERSONALIZATION);
    expect(visible.map((a) => a.slug)).toEqual(['a', 'b', 'c']);
    expect(hiddenApps).toEqual([]);
  });

  it('applies a custom order over the catalog', () => {
    const { visible } = applyPersonalization(CATALOG, { order: ['c', 'a', 'b'], hidden: [] });
    expect(visible.map((a) => a.slug)).toEqual(['c', 'a', 'b']);
  });

  it('appends a NEW catalog app (not in the stored order) at the end, default visible', () => {
    const { visible, hiddenApps } = applyPersonalization(CATALOG, { order: ['c', 'a'], hidden: [] });
    // 'b' is missing from the stored order (simulating a catalog app added after the order was saved).
    expect(visible.map((a) => a.slug)).toEqual(['c', 'a', 'b']);
    expect(hiddenApps).toEqual([]);
  });

  it('drops a REMOVED catalog app from the stored order gracefully (no crash, no ghost entry)', () => {
    const { visible, hiddenApps } = applyPersonalization(CATALOG, { order: ['z', 'c', 'a', 'b'], hidden: [] });
    expect(visible.map((a) => a.slug)).toEqual(['c', 'a', 'b']);
    expect(hiddenApps).toEqual([]);
  });

  it('moves a hidden app out of visible and into hiddenApps, preserving catalog order among hidden apps', () => {
    const { visible, hiddenApps } = applyPersonalization(CATALOG, { order: [], hidden: ['b'] });
    expect(visible.map((a) => a.slug)).toEqual(['a', 'c']);
    expect(hiddenApps.map((a) => a.slug)).toEqual(['b']);
  });

  it('a hidden id no longer in the catalog vanishes entirely (not visible, not in hiddenApps)', () => {
    const { visible, hiddenApps } = applyPersonalization(CATALOG, { order: [], hidden: ['z'] });
    expect(visible.map((a) => a.slug)).toEqual(['a', 'b', 'c']);
    expect(hiddenApps).toEqual([]);
  });

  it('combines a custom order with hidden apps', () => {
    const { visible, hiddenApps } = applyPersonalization(CATALOG, { order: ['c', 'b', 'a'], hidden: ['b'] });
    expect(visible.map((a) => a.slug)).toEqual(['c', 'a']);
    expect(hiddenApps.map((a) => a.slug)).toEqual(['b']);
  });
});

describe('moveByIndex', () => {
  it('moves an item from one index to another', () => {
    expect(moveByIndex(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
    expect(moveByIndex(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
  });

  it('is a no-op when indices are equal or out of range', () => {
    const arr = ['a', 'b', 'c'];
    expect(moveByIndex(arr, 1, 1)).toEqual(arr);
    expect(moveByIndex(arr, -1, 1)).toEqual(arr);
    expect(moveByIndex(arr, 0, 5)).toEqual(arr);
  });
});

describe('reorderState', () => {
  it('sets order to the visible sequence with the drag move applied', () => {
    const next = reorderState(DEFAULT_PERSONALIZATION, ['a', 'b', 'c'], 2, 0);
    expect(next.order).toEqual(['c', 'a', 'b']);
    expect(next.hidden).toEqual([]);
  });
});

describe('moveAppState (keyboard reorder)', () => {
  it('moves an app up one slot', () => {
    const next = moveAppState(DEFAULT_PERSONALIZATION, ['a', 'b', 'c'], 'c', 'up');
    expect(next.order).toEqual(['a', 'c', 'b']);
  });

  it('moves an app down one slot', () => {
    const next = moveAppState(DEFAULT_PERSONALIZATION, ['a', 'b', 'c'], 'a', 'down');
    expect(next.order).toEqual(['b', 'a', 'c']);
  });

  it('is a no-op at the top edge (up) or bottom edge (down)', () => {
    expect(moveAppState(DEFAULT_PERSONALIZATION, ['a', 'b', 'c'], 'a', 'up')).toEqual(DEFAULT_PERSONALIZATION);
    expect(moveAppState(DEFAULT_PERSONALIZATION, ['a', 'b', 'c'], 'c', 'down')).toEqual(DEFAULT_PERSONALIZATION);
  });

  it('is a no-op for an id not present in the visible sequence', () => {
    expect(moveAppState(DEFAULT_PERSONALIZATION, ['a', 'b', 'c'], 'zzz', 'up')).toEqual(DEFAULT_PERSONALIZATION);
  });
});

describe('hideAppState / showAppState', () => {
  it('hides an app (idempotent)', () => {
    const once = hideAppState(DEFAULT_PERSONALIZATION, 'b');
    expect(once.hidden).toEqual(['b']);
    const twice = hideAppState(once, 'b');
    expect(twice.hidden).toEqual(['b']);
  });

  it('shows a hidden app again (idempotent)', () => {
    const hidden = hideAppState(DEFAULT_PERSONALIZATION, 'b');
    const shown = showAppState(hidden, 'b');
    expect(shown.hidden).toEqual([]);
    expect(showAppState(shown, 'b')).toEqual(shown);
  });
});
