import { useEffect } from 'react';
import { useAppSelector } from '@/app/hooks';
import { resolveEffectiveTheme } from '@/lib/theme';

const DARK_QUERY = '(prefers-color-scheme: dark)';

/**
 * Apply the active theme mode (#111) to `documentElement.dataset.digTheme` — the attribute
 * `theme.css` keys its dark palette off of (`:root[data-dig-theme='dark']`). Mounted once in
 * `Shell` (App.tsx) so it runs regardless of which tab/screen is showing, covering popup AND
 * fullscreen (both render the same `Shell`). When the mode is `system`, this ALSO subscribes to
 * live OS theme changes for as long as the document stays open, so switching your OS theme while
 * the popup/app is open repaints immediately — no reopen needed. Degrades to `light` if
 * `matchMedia` is unavailable (e.g. a non-browser test environment) rather than throwing.
 */
export function useAppliedTheme(): void {
  const mode = useAppSelector((s) => s.ui.theme);

  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const mql =
      typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(DARK_QUERY) : null;

    const apply = () => {
      document.documentElement.dataset.digTheme = resolveEffectiveTheme(mode, mql?.matches ?? false);
    };
    apply();

    if (mode === 'system' && mql) {
      mql.addEventListener('change', apply);
      return () => mql.removeEventListener('change', apply);
    }
    return undefined;
  }, [mode]);
}
