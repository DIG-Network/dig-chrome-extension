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
  role,
  onClick: onClickProp,
}: {
  href: string;
  children: ReactNode;
  className?: string;
  testid?: string;
  closePopup?: boolean;
  /** Optional ARIA role override (e.g. `menuitem` when rendered inside a `role="menu"` popover). */
  role?: string;
  /** Optional extra handler fired on every click (e.g. closing a parent menu) — runs unconditionally,
   * before the tab-opening logic below. */
  onClick?: () => void;
}) {
  const onClick = (e: React.MouseEvent) => {
    onClickProp?.();
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
    <a href={href} target="_blank" rel="noreferrer noopener" className={className} data-testid={testid} role={role} onClick={onClick}>
      {children}
    </a>
  );
}
