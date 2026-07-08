/**
 * Theme selection (#111) — light/dark/system, resolved to a concrete `light`/`dark` paint. Pure
 * (no DOM/`matchMedia`), so the resolution logic is unit-testable; `App.tsx`'s `ThemeGate` is the
 * only place that reads `matchMedia('(prefers-color-scheme: dark)')` and applies the result as
 * `document.documentElement.dataset.digTheme`, which `theme.css` keys its dark palette off of.
 * Persisted to `wallet.settings.theme` via the same `uiSlice`/`storageSync` bridge as the locale
 * preference (§6.6), so the choice survives a popup reopen and applies to popup + fullscreen alike.
 */

/** The three selectable theme modes — `system` follows the OS `prefers-color-scheme`. */
export const THEME_MODES = ['light', 'dark', 'system'] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

/** The default mode: follow the OS until the user picks an explicit theme. */
export const DEFAULT_THEME_MODE: ThemeMode = 'system';

const MODES = new Set<string>(THEME_MODES);

/** True if `value` is one of the three supported theme modes. */
export function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === 'string' && MODES.has(value);
}

/** The two concrete paints a `ThemeMode` can resolve to. */
export type EffectiveTheme = 'light' | 'dark';

/**
 * Resolve a `ThemeMode` to the concrete paint to apply: `light`/`dark` pass through unchanged;
 * `system` follows the caller-supplied OS signal (`matchMedia('(prefers-color-scheme: dark)').matches`).
 */
export function resolveEffectiveTheme(mode: ThemeMode, prefersDark: boolean): EffectiveTheme {
  if (mode === 'system') return prefersDark ? 'dark' : 'light';
  return mode;
}
