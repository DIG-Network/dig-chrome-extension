/**
 * Apps-tab personalization (#164) — the PURE data logic for the user's LOCAL, per-device view over
 * the server-owned dApp catalog (`storeCatalog.ts`): a custom display order + a hidden-app set,
 * keyed by app `slug`. The catalog itself is never mutated; this module only computes a view
 * transform over it, so a catalog refresh (new/removed apps) can never corrupt the saved prefs.
 *
 * `order` need not (and usually won't) list every catalog id — {@link applyPersonalization}
 * reconciles it against the LIVE catalog on every read: ids no longer in the catalog are dropped
 * silently (no ghost entries, no crash), and ids present in the catalog but absent from `order`
 * (a brand-new app, or one added before the user ever reordered) are appended at the end, in the
 * catalog's own order. `hidden` is reconciled the same way. This is what makes catalog churn a
 * non-event: no migration step is ever needed when explore.dig.net adds or retires a dApp.
 *
 * No DOM / `chrome.*` here — the storage seam (`usePersonalizedApps`) and the UI are thin glue over
 * this module, so every branch (including catalog-churn reconciliation) is unit-testable without a
 * browser (mirrors the `contacts.ts` / `wallet-assets.ts` pure-core idiom).
 */

import type { StoreApp } from '@/features/apps/storeCatalog';

/** `chrome.storage.local` key for the durable per-device personalization (§18.4 non-secret client data). */
export const APPS_PERSONALIZATION_KEY = 'apps.personalization';

/** The user's saved Apps-tab personalization. Both arrays hold app `slug`s. */
export interface PersonalizationState {
  /** Custom display order of (some or all) app ids. Reconciled against the live catalog on read. */
  order: string[];
  /** Ids hidden from the main grid, recoverable via "show hidden". */
  hidden: string[];
}

/** The empty personalization: catalog order, nothing hidden. */
export const DEFAULT_PERSONALIZATION: PersonalizationState = { order: [], hidden: [] };

/** Coerce a raw stored value into a clean {@link PersonalizationState}, dropping any non-string entries. */
export function parsePersonalization(stored: unknown): PersonalizationState {
  if (!stored || typeof stored !== 'object') return { order: [], hidden: [] };
  const o = stored as Record<string, unknown>;
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  return { order: strings(o.order), hidden: strings(o.hidden) };
}

/**
 * Reconcile a stored id list against the live `universe`: ids present in both keep the stored
 * relative order; ids in `universe` but missing from `stored` are appended at the end, in
 * `universe`'s own order; ids in `stored` but no longer in `universe` are dropped.
 */
function reconcileOrder(universe: readonly string[], stored: readonly string[]): string[] {
  const known = stored.filter((id) => universe.includes(id));
  const rest = universe.filter((id) => !stored.includes(id));
  return [...known, ...rest];
}

/** The catalog split into the personalized visible grid + the hidden-apps list (both render-ready). */
export interface PersonalizedCatalog {
  visible: StoreApp[];
  hiddenApps: StoreApp[];
}

/**
 * Apply {@link PersonalizationState} to a live catalog: reorder the visible apps per the saved
 * order (reconciled for catalog churn), and split out hidden apps into their own list (also
 * reconciled — a hidden id no longer in the catalog simply vanishes, it does not linger anywhere).
 */
export function applyPersonalization(apps: readonly StoreApp[], state: PersonalizationState): PersonalizedCatalog {
  const catalogIds = apps.map((a) => a.slug);
  const byId = new Map(apps.map((a) => [a.slug, a]));
  const hiddenSet = new Set(state.hidden.filter((id) => catalogIds.includes(id)));

  const visibleCatalogIds = catalogIds.filter((id) => !hiddenSet.has(id));
  const orderedVisibleIds = reconcileOrder(visibleCatalogIds, state.order);

  return {
    visible: orderedVisibleIds.map((id) => byId.get(id)!),
    hiddenApps: catalogIds.filter((id) => hiddenSet.has(id)).map((id) => byId.get(id)!),
  };
}

/** Move the item at `from` to index `to` in a new array (pure array-move). No-op out of range. */
export function moveByIndex<T>(arr: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= arr.length || to >= arr.length) return arr.slice();
  const copy = arr.slice();
  const [item] = copy.splice(from, 1);
  copy.splice(to, 0, item);
  return copy;
}

/**
 * Apply a drag/drop-index reorder over the CURRENT visible id sequence (already reconciled by
 * {@link applyPersonalization}), persisting the result as the new explicit `order`.
 */
export function reorderState(state: PersonalizationState, visibleIds: readonly string[], from: number, to: number): PersonalizationState {
  return { ...state, order: moveByIndex(visibleIds, from, to) };
}

/**
 * Keyboard-accessible reorder: move `id` one slot up or down within the current visible sequence.
 * A no-op when `id` is absent or already at that edge (top for "up", bottom for "down").
 */
export function moveAppState(
  state: PersonalizationState,
  visibleIds: readonly string[],
  id: string,
  direction: 'up' | 'down',
): PersonalizationState {
  const from = visibleIds.indexOf(id);
  if (from < 0) return state;
  const to = direction === 'up' ? from - 1 : from + 1;
  if (to < 0 || to >= visibleIds.length) return state;
  return reorderState(state, visibleIds, from, to);
}

/** Hide an app (idempotent — hiding an already-hidden id is a no-op). */
export function hideAppState(state: PersonalizationState, id: string): PersonalizationState {
  if (state.hidden.includes(id)) return state;
  return { ...state, hidden: [...state.hidden, id] };
}

/** Show a previously-hidden app again (idempotent — showing a non-hidden id is a no-op). */
export function showAppState(state: PersonalizationState, id: string): PersonalizationState {
  if (!state.hidden.includes(id)) return state;
  return { ...state, hidden: state.hidden.filter((x) => x !== id) };
}
