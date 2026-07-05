import { useEffect, useState } from 'react';

/**
 * Subscribe to a CSS media query, returning whether it currently matches. Used by
 * `useLayoutMode` so `app.html` can degrade to the compact layout in a narrow window while the
 * popup stays compact by construction. SSR/degraded environments (no `matchMedia`) resolve false.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}
