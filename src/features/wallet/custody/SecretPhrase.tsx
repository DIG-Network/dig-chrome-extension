import { useEffect, useRef } from 'react';

/**
 * Renders `words` as an ordered list inside a **closed shadow root** so the secret text is not
 * reachable from the light DOM (#67 P1-5). A closed root's `host.shadowRoot` is `null` and its
 * nodes never surface in `document.querySelector` / `textContent` harvesting — so another
 * extension, an injected page script, or any other part of our OWN UI cannot scrape a revealed
 * recovery phrase (or, later, an exported private key). Screen readers and keyboard navigation
 * still traverse the shadow subtree, so accessibility is preserved.
 *
 * This is our own minimal DOM-isolation primitive — no third-party reveal library. The words are
 * built imperatively (never through React's light-DOM tree, which would be scrapeable). CSS custom
 * properties inherit through the shadow boundary, so the app's `--dig-mono` font still applies.
 */
export function SecretPhrase({
  words,
  ariaLabel,
  testid = 'recovery-words',
}: {
  words: string[];
  ariaLabel: string;
  testid?: string;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const shadowRef = useRef<ShadowRoot | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // `attachShadow` may be called at most once per element; guard it across React StrictMode's
    // mount → cleanup → mount double-invoke (which reuses the same host node).
    if (!shadowRef.current) shadowRef.current = host.attachShadow({ mode: 'closed' });
    const root = shadowRef.current;
    root.replaceChildren();
    const style = document.createElement('style');
    style.textContent =
      'ol{columns:2;gap:12px;margin:12px 0;padding-inline-start:24px}' +
      'li{font-family:var(--dig-mono,monospace);padding:2px 0}';
    const ol = document.createElement('ol');
    ol.setAttribute('aria-label', ariaLabel);
    for (const w of words) {
      const li = document.createElement('li');
      li.textContent = w;
      ol.appendChild(li);
    }
    root.append(style, ol);
    // Clear the secret from the shadow subtree on unmount / auto-hide.
    return () => root.replaceChildren();
  }, [words, ariaLabel]);

  // The host carries only the (non-secret) word count for tests/agents — never the words.
  return <div ref={hostRef} data-testid={testid} data-word-count={words.length} />;
}
