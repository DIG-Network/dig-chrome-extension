import { useMediaQuery } from '@/lib/useMediaQuery';

/** Which HTML entry point mounted the app: the toolbar popup, or the full-page `app.html` tab. */
export type Surface = 'popup' | 'fullpage';

/** The chrome the shell renders: compact (bottom-bar) vs expanded (sidebar + columns). */
export type LayoutMode = 'compact' | 'expanded';

/** The width at/above which `app.html` uses the expanded wallet layout. */
export const EXPANDED_MIN_WIDTH = 960;

/**
 * Pick the layout for a surface. The popup is inherently constrained (Chromium caps popups
 * ~800×600) so it is ALWAYS compact; `app.html` uses width so a narrow window degrades to compact.
 */
export function useLayoutMode(surface: Surface): LayoutMode {
  const wide = useMediaQuery(`(min-width: ${EXPANDED_MIN_WIDTH}px)`);
  if (surface === 'popup') return 'compact';
  return wide ? 'expanded' : 'compact';
}
