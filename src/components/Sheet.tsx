import { useEffect, useRef, type ReactNode } from 'react';

/**
 * A modal dialog used for the Send / Receive actions — a bottom sheet on compact, a centered modal
 * on wide (the SAME component per the IA). Accessible: `role="dialog"` + `aria-modal`, focus moves
 * in on open + is restored on close, Tab is TRAPPED within the dialog (WCAG 2.2 — focus can't reach
 * the inert page behind it), Escape closes, a backdrop click closes. Copy is passed in by the caller
 * (already localized).
 */
export function Sheet({
  title,
  onClose,
  children,
  testid,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  testid?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const restoreTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    restoreTo.current = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      // Trap Tab within the dialog so keyboard focus can't reach the inert page behind it (WCAG 2.2).
      if (e.key !== 'Tab') return;
      const dialog = ref.current;
      if (!dialog) return;
      const focusable = dialog.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) {
        e.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === dialog)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      restoreTo.current?.focus?.();
    };
  }, [onClose]);

  return (
    <div className="dig-sheet-backdrop" data-testid={testid} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="dig-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={ref}
      >
        <div className="dig-sheet-head">
          <h2 className="dig-heading" style={{ margin: 0 }}>
            {title}
          </h2>
          <button type="button" className="dig-iconbtn" aria-label="Close" data-testid="sheet-close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="dig-sheet-body">{children}</div>
      </div>
    </div>
  );
}
