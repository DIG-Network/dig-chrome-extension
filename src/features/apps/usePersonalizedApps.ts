import { useCallback, useMemo } from 'react';
import { useStorageValue } from '@/lib/useStorageValue';
import {
  APPS_PERSONALIZATION_KEY,
  DEFAULT_PERSONALIZATION,
  parsePersonalization,
  applyPersonalization,
  reorderState,
  moveAppState,
  hideAppState,
  showAppState,
} from '@/features/apps/personalization';
import type { StoreApp } from '@/features/apps/storeCatalog';

/**
 * The Apps-tab personalization state seam (#164). Reads the durable `chrome.storage.local` key live
 * via `useStorageValue` (so the popup + `app.html` converge on `storage.onChanged`, §3.4) and
 * exposes the personalized view of `apps` (custom order + hidden split) plus the mutating actions a
 * drag/keyboard-reorder UI and a hide/show-hidden UI need. All logic delegates to the pure
 * `personalization` module; this hook only owns the storage read/write (mirrors `useContacts`).
 */
export function usePersonalizedApps(apps: StoreApp[]) {
  const [raw, setRaw, ready] = useStorageValue<unknown>(APPS_PERSONALIZATION_KEY, DEFAULT_PERSONALIZATION);
  const state = useMemo(() => parsePersonalization(raw), [raw]);
  const { visible, hiddenApps } = useMemo(() => applyPersonalization(apps, state), [apps, state]);
  const visibleIds = useMemo(() => visible.map((a) => a.slug), [visible]);

  const reorder = useCallback(
    (from: number, to: number): void => {
      setRaw(reorderState(state, visibleIds, from, to));
    },
    [state, visibleIds, setRaw],
  );

  const moveApp = useCallback(
    (id: string, direction: 'up' | 'down'): void => {
      setRaw(moveAppState(state, visibleIds, id, direction));
    },
    [state, visibleIds, setRaw],
  );

  const hideApp = useCallback(
    (id: string): void => {
      setRaw(hideAppState(state, id));
    },
    [state, setRaw],
  );

  const showApp = useCallback(
    (id: string): void => {
      setRaw(showAppState(state, id));
    },
    [state, setRaw],
  );

  return { visible, hiddenApps, ready, reorder, moveApp, hideApp, showApp };
}
