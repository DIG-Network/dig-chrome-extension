import type { ReactNode } from 'react';
import { hasRuntime } from '@/lib/messaging';

/**
 * Open an external URL in a new browser tab. Inside the extension it uses `chrome.tabs.create`
 * (and closes the popup) so the funnel behaves like the legacy popup; elsewhere it degrades to a
 * plain anchor. Rendered as a real `<a>` for accessibility + agent-navigability.
 */
export function ExternalLink({
  href,
  children,
  className = 'dig-link',
  testid,
  closePopup = false,
}: {
  href: string;
  children: ReactNode;
  className?: string;
  testid?: string;
  closePopup?: boolean;
}) {
  const onClick = (e: React.MouseEvent) => {
    if (hasRuntime() && chrome.tabs?.create) {
      e.preventDefault();
      void chrome.tabs.create({ url: href });
      if (closePopup) {
        try {
          window.close();
        } catch {
          /* ignore */
        }
      }
    }
  };
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className={className} data-testid={testid} onClick={onClick}>
      {children}
    </a>
  );
}
